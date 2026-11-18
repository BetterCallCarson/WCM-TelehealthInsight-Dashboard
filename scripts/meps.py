#!/usr/bin/env python3
# Author: Jiajun (Carson) Chen
# email: jic4015@med.cornell.edu
"""Rebuild annual aggregate MEPS dashboard data using Python's standard library.

Run from any directory: python3 scripts/meps.py --download
Downloads the selected year’s public event and person ASCII releases plus official Stata column
specifications into ignored .work/. Only aggregate JSON is published.
"""
from __future__ import annotations

import argparse
from datetime import date
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
# Event file, person file, and AHRQ all-event benchmarks (including zero payments).
# Benchmarks are weighted millions of visits, mean total and SE, mean family and SE.
RELEASES = {
    2021: ("h229g", "h233", (2271.4, 293, 9.3, 52, 4.6)),
    2022: ("h239g", "h243", (2077.9, 294, 7.4, 57, 4.1)),
    2023: ("h248g", "h251", (2214.2, 285, 6.1, 53, 2.6)),
    2024: ("h254g", "h256", (2410.1, 308, 7.9, 57, 3.0)),
}
INSURANCE = {1: "Any private", 2: "Public only", 3: "Uninsured all year"}
MODALITIES = ["In person", "Phone", "Video", "Other remote", "Unknown remote"]


def read_ascii(work: Path, puf: str, requested: list[str]) -> list[dict]:
    """Reads requested columns using the agency's released infix specification.

    Args:
        work: Directory containing downloaded archives and Stata specifications.
        puf: Public-use file identifier, such as h254g or h256.
        requested: Exact source column names to retain.

    Returns:
        Typed source records with string identifiers preserved.

    Raises:
        ValueError: A requested column is absent, archive members are ambiguous,
            or a numeric field cannot be parsed.
        OSError: A required local file cannot be read.
    """
    spec = (work / f"meps-{puf}stu.txt").read_text()
    fields = {
        name: (int(start) - 1, int(end), kind)
        for kind, name, start, end in re.findall(
            r"^\s*(long|int|str|byte|double|float)\s+(\w+)\s+(\d+)-(\d+)",
            spec,
            re.M,
        )
    }
    missing = set(requested) - fields.keys()
    if missing:
        raise ValueError(f"Missing schema columns: {missing}")
    with zipfile.ZipFile(work / f"meps-{puf}dat.zip") as archive:
        candidates = [
            x for x in archive.namelist() if x.lower().endswith(".dat")
        ]
        if len(candidates) != 1:
            raise ValueError(f"Expected one ASCII file in {puf}")
        lines = archive.read(candidates[0]).decode("ascii").splitlines()
    result = []
    for line in lines:
        row = {}
        for name in requested:
            start, end, kind = fields[name]
            raw = line[start:end].strip()
            row[name] = (
                raw
                if kind == "str"
                else (float(raw) if kind in ("double", "float") else int(raw))
            )
        result.append(row)
    return result


def ratio_summary(
    rows: list[dict], psus: dict, value, scale=1.0, proportion=False
) -> dict:
    """Taylor-linearized ratio mean; domain rows retain the full PSU universe.

    R = sum(w*y) / sum(w). For each stratum h and PSU j, aggregate
    u_hj = sum_i(w_i * (y_i - R)) / sum_i(w_i) over domain records.
    Var(R) = sum_h [m_h/(m_h-1) * sum_j(u_hj - mean_h(u))**2].
    PSUs with no domain observations contribute zero, not deletion.
    Uses the with-replacement public design; no FPC. Intervals are normal
    approximations (1.959964 * SE), clipped to the natural parameter range.

    Args:
        rows: Positive-weight visit records in the denominator domain.
        psus: Full person-design mapping from stratum to PSU identifiers,
            including PSUs without visits in this domain.
        value: Callable returning a nonnegative payment or 0/1 indicator.
        scale: Output multiplier, normally 1 for dollars or 100 for percent.
        proportion: Whether to cap interval endpoints at the 0–1 boundary.

    Returns:
        Estimate, interval, SE, denominator counts, and instability flags.
        An empty domain returns null estimates rather than a false zero.

    Raises:
        ValueError: A stratum has fewer than two PSUs; no silent correction
            is allowed for an unidentified within-stratum variance.
    """
    n = len(rows)
    if not n:
        return {
            "estimate": None,
            "ci_low": None,
            "ci_high": None,
            "se": None,
            "n": 0,
            "n_persons": 0,
            "weighted_denominator": 0,
            "unstable": True,
            "flags": ["No eligible visits"],
        }
    total_w = math.fsum(r["weight"] for r in rows)
    estimate = math.fsum(r["weight"] * value(r) for r in rows) / total_w
    sums = defaultdict(float)
    for row in rows:
        sums[(row["VARSTR"], row["VARPSU"])] += (
            row["weight"] * (value(row) - estimate) / total_w
        )
    variance = 0.0
    for stratum, units in psus.items():
        if len(units) < 2:
            raise ValueError(
                f"Single PSU stratum {stratum}; no silent correction is permitted"
            )
        values = [sums[(stratum, unit)] for unit in units]
        average = math.fsum(values) / len(values)
        variance += (
            len(values)
            / (len(values) - 1)
            * math.fsum((v - average) ** 2 for v in values)
        )
    se = math.sqrt(variance)
    low = max(0.0, estimate - 1.959963984540054 * se)
    high = estimate + 1.959963984540054 * se
    if proportion:
        high = min(1.0, high)
    people = len({r["DUPERSID"] for r in rows})
    flags = []
    if people < 30:
        flags.append("Fewer than 30 sampled persons")
    if estimate > 0 and se / estimate > 0.30:
        flags.append("Relative standard error exceeds 30%")
    if proportion and not 0 < estimate < 1:
        flags.append("Boundary estimate; normal interval is unreliable")
    return {
        "estimate": round(estimate * scale, 6),
        "ci_low": round(low * scale, 6),
        "ci_high": round(high * scale, 6),
        "se": round(se * scale, 6),
        "n": n,
        "n_persons": people,
        "weighted_denominator": round(total_w, 4),
        "unstable": bool(flags),
        "flags": flags,
    }


def main():
    """Links MEPS events to persons and writes reproducible visit aggregates.

    CLI options select input/output paths, optional downloads, and access date.
    Duplicate IDs, unmatched linkage, unexpected codes, and inconsistent survey
    weights/design identifiers stop processing before output is published.
    The full positive-weight person design supplies PSUs for every visit domain.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--download",
        action="store_true",
        help="Fetch missing source files with curl",
    )
    parser.add_argument("--work-dir", type=Path, default=ROOT / ".work")
    parser.add_argument(
        "--output", type=Path, default=None
    )
    parser.add_argument(
        "--access-date",
        default=date.today().isoformat(),
        help="Recorded date of source retrieval",
    )
    parser.add_argument("--year", type=int, choices=RELEASES, default=2024)
    args = parser.parse_args()
    year = args.year
    yy = str(year)[-2:]
    event_id, person_id, benchmarks = RELEASES[year]
    if args.output is None:
        args.output = ROOT / "data" / ("meps.json" if year == 2024 else f"meps-{year}.json")
    sources = {}
    for puf in (event_id, person_id):
        base = "https://meps.ahrq.gov/mepsweb"
        sources[puf + "dat.zip"] = f"{base}/data_files/pufs/{puf}/{puf}dat.zip"
        sources[puf + "stu.txt"] = f"{base}/data_stats/download_data/pufs/{puf}/{puf}stu.txt"
    weight, insurance = f"PERWT{yy}F", f"INSCOV{yy}"
    total, family = f"OBXP{yy}X", f"OBSF{yy}X"
    args.work_dir.mkdir(parents=True, exist_ok=True)
    provenance = []
    for filename, url in sources.items():
        path = args.work_dir / f"meps-{filename}"
        if not path.exists():
            if not args.download:
                raise FileNotFoundError(f"{path}; rerun with --download")
            subprocess.run(
                [
                    "curl",
                    "--location",
                    "--fail",
                    "--silent",
                    "--show-error",
                    url,
                    "--output",
                    str(path),
                ],
                check=True,
            )
        provenance.append(
            {
                "file": filename,
                "url": url,
                "accessed": args.access_date,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "bytes": path.stat().st_size,
            }
        )
    people = read_ascii(
        args.work_dir,
        person_id,
        ["DUPERSID", insurance, weight, "VARSTR", "VARPSU"],
    )
    events = read_ascii(
        args.work_dir,
        event_id,
        [
            "DUPERSID",
            "EVNTIDX",
            "TELEHEALTHFLAG",
            "VISITTYPE",
            total,
            family,
            weight,
            "VARSTR",
            "VARPSU",
            "IMPFLAG",
        ],
    )
    people_by_id = {r["DUPERSID"]: r for r in people}
    assert len(people_by_id) == len(people), "Duplicate person identifiers"
    assert len({r["EVNTIDX"] for r in events}) == len(
        events
    ), "Duplicate event identifiers"
    unmatched = sum(r["DUPERSID"] not in people_by_id for r in events)
    assert unmatched == 0, "Unmatched event-to-person linkage"
    for event in events:
        event["weight"] = event[weight]
        person = people_by_id[event["DUPERSID"]]
        assert (
            event[weight] == person[weight]
        ), "Mismatched event/person weights"
        assert (event["VARSTR"], event["VARPSU"]) == (
            person["VARSTR"],
            person["VARPSU"],
        ), "Mismatched design"
        event["insurance"] = INSURANCE.get(person[insurance], "Unknown")
        if event["TELEHEALTHFLAG"] == 2:
            assert event["VISITTYPE"] == -1, "Unexpected nonremote modality"
            event["modality"] = "In person"
        elif event["TELEHEALTHFLAG"] == 1:
            event["modality"] = {1: "Phone", 2: "Video", 3: "Other remote"}.get(
                event["VISITTYPE"], "Unknown remote"
            )
        else:
            raise ValueError(
                "Unexpected telehealth flag; review before publishing"
            )
    eligible = [r for r in events if r["weight"] > 0]
    psus = defaultdict(set)
    for person in people:
        if person[weight] > 0:
            psus[person["VARSTR"]].add(person["VARPSU"])
    assert all(
        r[total] >= 0 and r[family] >= 0 for r in eligible
    ), "Negative payment code"
    assert all(
        r["insurance"] != "Unknown" for r in eligible
    ), "Unknown insurance category"
    summaries = []
    for group_name in ["All", *INSURANCE.values()]:
        domain = [
            r
            for r in eligible
            if group_name == "All" or r["insurance"] == group_name
        ]
        telehealth = [r for r in domain if r["TELEHEALTHFLAG"] == 1]
        summary = {
            "insurance": group_name,
            "n": len(domain),
            "n_persons": len({r["DUPERSID"] for r in domain}),
            "telehealth_n": len(telehealth),
            "telehealth_n_persons": len({r["DUPERSID"] for r in telehealth}),
            "telehealth_pct": ratio_summary(
                domain, psus, lambda r: r["TELEHEALTHFLAG"] == 1, 100, True
            ),
            "total_payment": ratio_summary(
                domain, psus, lambda r: r[total]
            ),
            "family_payment": ratio_summary(
                domain, psus, lambda r: r[family]
            ),
            "modalities": [],
        }
        for modality in MODALITIES:
            subset = [r for r in domain if r["modality"] == modality]
            summary["modalities"].append(
                {
                    "modality": modality,
                    "n": len(subset),
                    "n_persons": len({r["DUPERSID"] for r in subset}),
                    "share_pct": ratio_summary(
                        domain,
                        psus,
                        lambda r, m=modality: r["modality"] == m,
                        100,
                        True,
                    ),
                    "total_payment": ratio_summary(
                        subset, psus, lambda r: r[total]
                    ),
                    "family_payment": ratio_summary(
                        subset, psus, lambda r: r[family]
                    ),
                }
            )
        # Additional caution uses persons in numerator, not merely the large denominator.
        for modality in summary["modalities"]:
            if modality["n_persons"] < 30:
                modality["share_pct"]["unstable"] = True
                flag = "Fewer than 30 sampled persons with this modality"
                modality["share_pct"]["flags"].append(flag)
        if summary["telehealth_n_persons"] < 30:
            summary["telehealth_pct"]["unstable"] = True
            summary["telehealth_pct"]["flags"].append(
                "Fewer than 30 sampled persons with telehealth visits"
            )
        assert (
            abs(
                sum(x["share_pct"]["estimate"] for x in summary["modalities"])
                - 100
            )
            < 1e-4
        )
        summaries.append(summary)
    total_w = math.fsum(r["weight"] for r in eligible)
    overall = summaries[0]
    # Independent benchmarks: official HC-254G Table 3/4 rounded estimates and SEs.
    visits, total_mean, total_se, family_mean, family_se = benchmarks
    checks = {
        "weighted_visits_match_official_table": round(total_w / 1e6, 1) == visits,
        "total_mean_matches_official_table": round(overall["total_payment"]["estimate"]) == total_mean,
        "total_se_matches_official_table": round(overall["total_payment"]["se"], 1) == total_se,
        "family_mean_matches_official_table": round(overall["family_payment"]["estimate"]) == family_mean,
        "family_se_matches_official_table": round(overall["family_payment"]["se"], 1) == family_se,
    }
    assert all(checks.values()), f"Official benchmark mismatch: {checks}"
    output = {
        "schema_version": "1.0",
        "source": f"AHRQ MEPS HC-{event_id[1:].upper()} + HC-{person_id[1:]}",
        "year": year,
        "status": "computed_from_public_microdata",
        "accessed": args.access_date,
        "population": "Office-based visits, all ages, U.S. civilian noninstitutionalized population",
        "unit": "visit",
        "provenance": provenance,
        "documentation": [
            {"title": f"HC-{puf[1:].upper()} documentation",
             "url": f"https://meps.ahrq.gov/data_stats/download_data/pufs/{puf}/{puf}doc.pdf"}
            for puf in (event_id, person_id)
        ],
        "methods": {
            "weight": weight,
            "stratum": "VARSTR",
            "psu": "VARPSU",
            "estimator": "Survey-weighted ratio means; with-replacement Taylor linearization",
            "confidence_interval": "95% normal approximation: estimate +/- 1.959964 SE; clipped to [0,100] for percentages and to zero below for payments",
            "variance_domains": "The complete positive-weight full-year person-file PSU universe is retained; out-of-domain PSUs contribute zero influence.",
            "strata": len(psus),
            "psus": sum(len(x) for x in psus.values()),
            "design_df": sum(len(x) - 1 for x in psus.values()),
            "insurance_variable": insurance,
            "insurance_definition": f"Any private includes TRICARE/CHAMPVA at any time in {year}; public only has no private coverage; uninsured means uninsured all year. Categories describe annual coverage, not coverage on the visit date.",
            "share_denominator": "All positive-weight office visits within the selected insurance group, including remote visits with unknown modality",
            "payment_denominator": "Positive-weight visits in each displayed modality/insurance group; zero payments retained",
            "payment_units": f"{year} U.S. dollars per visit; released imputed values retained",
            "stability_rule": "Dashboard screening rule (not an official AHRQ release standard): flag fewer than 30 sampled persons in a payment domain, modality numerator, or telehealth numerator, RSE > 30%, or boundary proportions. Withhold those small-person-count estimates from the interface and display-ready CSV; preserve computed estimates in aggregate JSON.",
            "interpretation": "Descriptive, unadjusted comparisons; no causal or predictive interpretation. No patient-level linkage to NHIS.",
        },
        "quality": {
            "source_event_n": len(events),
            "source_person_n": len(people),
            "analytic_visit_n": len(eligible),
            "analytic_person_n": len({r["DUPERSID"] for r in eligible}),
            "zero_weight_visit_n": sum(r["weight"] == 0 for r in events),
            "telehealth_source_n": sum(
                r["TELEHEALTHFLAG"] == 1 for r in events
            ),
            "telehealth_analytic_n": sum(
                r["TELEHEALTHFLAG"] == 1 for r in eligible
            ),
            "inapplicable_modality_source_n": sum(
                r["VISITTYPE"] == -1 for r in events
            ),
            "unknown_remote_modality_source_n": sum(
                r["TELEHEALTHFLAG"] == 1 and r["VISITTYPE"] < 0 for r in events
            ),
            "unknown_remote_modality_analytic_n": sum(
                r["modality"] == "Unknown remote" for r in eligible
            ),
            "missing_telehealth_source_n": sum(
                r["TELEHEALTHFLAG"] not in (1, 2) for r in events
            ),
            "missing_payment_source_n": sum(
                r[total] < 0 or r[family] < 0 for r in events
            ),
            "unmatched_person_n": unmatched,
            "unknown_insurance_analytic_n": sum(
                r["insurance"] == "Unknown" for r in eligible
            ),
            "imputation_flag_source_counts": dict(
                sorted(Counter(r["IMPFLAG"] for r in events).items())
            ),
            "imputation_flag_labels": {
                "0": "Not eligible for imputation",
                "1": "Complete HC data",
                "2": "Complete MPC data",
                "3": "Fully imputed",
                "4": "Partially imputed",
                "5": "Capitation imputation",
            },
            "weighted_office_visits": round(total_w, 4),
            "checks": checks,
            "limitations": [
                "Visit-level estimates count people with repeated visits repeatedly; they do not estimate the percentage of people using telehealth.",
                "Unweighted codebook counts are distinct from weighted population estimates.",
                "VISITTYPE=-1 is structural inapplicability among nonremote visits; -8 is unknown remote modality.",
                "Payments contain released imputation; zero missing values do not mean payments were all directly observed.",
                "Payments are amounts paid, not charges or standardized prices. Case mix and service differences can explain comparisons.",
                "Normal confidence intervals are approximate, particularly for rare modalities; unstable estimates are flagged.",
            ],
        },
        "overall": overall,
        "groups": summaries,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2, allow_nan=False) + "\n")
    print(
        json.dumps(
            {
                "output": str(args.output),
                "analytic_n": len(eligible),
                "telehealth_pct": overall["telehealth_pct"],
                "checks": checks,
            }
        )
    )


if __name__ == "__main__":
    main()
