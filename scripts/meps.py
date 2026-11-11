#!/usr/bin/env python3
# Author: Jiajun (Carson) Chen
# email: jic4015@med.cornell.edu
"""Rebuild aggregate MEPS 2024 dashboard data using Python's standard library.

Run from any directory: python3 scripts/meps.py --download
Downloads public HC-254G and HC-256 ASCII releases plus official Stata column
specifications into ignored .work/. Only aggregate JSON is published.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "h254gdat.zip": "https://meps.ahrq.gov/mepsweb/data_files/pufs/h254g/h254gdat.zip",
    "h256dat.zip": "https://meps.ahrq.gov/mepsweb/data_files/pufs/h256/h256dat.zip",
    "h254gstu.txt": "https://meps.ahrq.gov/mepsweb/data_stats/download_data/pufs/h254g/h254gstu.txt",
    "h256stu.txt": "https://meps.ahrq.gov/mepsweb/data_stats/download_data/pufs/h256/h256stu.txt",
}
DOC_EVENT = (
    "https://meps.ahrq.gov/data_stats/download_data/pufs/h254g/h254gdoc.shtml"
)
DOC_PERSON = (
    "https://meps.ahrq.gov/data_stats/download_data/pufs/h256/h256doc.shtml"
)
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
    total_w = math.fsum(r["PERWT24F"] for r in rows)
    estimate = math.fsum(r["PERWT24F"] * value(r) for r in rows) / total_w
    sums = defaultdict(float)
    for row in rows:
        sums[(row["VARSTR"], row["VARPSU"])] += (
            row["PERWT24F"] * (value(row) - estimate) / total_w
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
        "--output", type=Path, default=ROOT / "data" / "meps.json"
    )
    parser.add_argument(
        "--access-date",
        default="2026-11-11",
        help="Recorded date of source retrieval",
    )
    args = parser.parse_args()
    args.work_dir.mkdir(parents=True, exist_ok=True)
    provenance = []
    for filename, url in SOURCES.items():
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
        "h256",
        ["DUPERSID", "INSCOV24", "PERWT24F", "VARSTR", "VARPSU"],
    )
    events = read_ascii(
        args.work_dir,
        "h254g",
        [
            "DUPERSID",
            "EVNTIDX",
            "TELEHEALTHFLAG",
            "VISITTYPE",
            "OBXP24X",
            "OBSF24X",
            "PERWT24F",
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
        person = people_by_id[event["DUPERSID"]]
        assert (
            event["PERWT24F"] == person["PERWT24F"]
        ), "Mismatched event/person weights"
        assert (event["VARSTR"], event["VARPSU"]) == (
            person["VARSTR"],
            person["VARPSU"],
        ), "Mismatched design"
        event["insurance"] = INSURANCE.get(person["INSCOV24"], "Unknown")
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
    eligible = [r for r in events if r["PERWT24F"] > 0]
    psus = defaultdict(set)
    for person in people:
        if person["PERWT24F"] > 0:
            psus[person["VARSTR"]].add(person["VARPSU"])
    assert all(
        r["OBXP24X"] >= 0 and r["OBSF24X"] >= 0 for r in eligible
    ), "Negative payment code"
    assert all(
        r["insurance"] != "Unknown" for r in eligible
    ), "Unknown insurance category"
    summaries = []
    for insurance in ["All", *INSURANCE.values()]:
        domain = [
            r
            for r in eligible
            if insurance == "All" or r["insurance"] == insurance
        ]
        telehealth = [r for r in domain if r["TELEHEALTHFLAG"] == 1]
        summary = {
            "insurance": insurance,
            "n": len(domain),
            "n_persons": len({r["DUPERSID"] for r in domain}),
            "telehealth_n": len(telehealth),
            "telehealth_n_persons": len({r["DUPERSID"] for r in telehealth}),
            "telehealth_pct": ratio_summary(
                domain, psus, lambda r: r["TELEHEALTHFLAG"] == 1, 100, True
            ),
            "total_payment": ratio_summary(
                domain, psus, lambda r: r["OBXP24X"]
            ),
            "family_payment": ratio_summary(
                domain, psus, lambda r: r["OBSF24X"]
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
                        subset, psus, lambda r: r["OBXP24X"]
                    ),
                    "family_payment": ratio_summary(
                        subset, psus, lambda r: r["OBSF24X"]
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
    total_w = math.fsum(r["PERWT24F"] for r in eligible)
    overall = summaries[0]
    # Independent benchmarks: official HC-254G Table 3/4 rounded estimates and SEs.
    checks = {
        "source_rows_equal_145818": len(events) == 145818,
        "positive_weight_rows_equal_144206": len(eligible) == 144206,
        "population_visits_round_to_2410_1_million": round(total_w / 1e6, 1)
        == 2410.1,
        "mean_total_payment_rounds_to_308": round(
            overall["total_payment"]["estimate"]
        )
        == 308,
        "se_total_payment_rounds_to_7_9": round(
            overall["total_payment"]["se"], 1
        )
        == 7.9,
        "mean_family_payment_rounds_to_57": round(
            overall["family_payment"]["estimate"]
        )
        == 57,
        "se_family_payment_rounds_to_3_0": round(
            overall["family_payment"]["se"], 1
        )
        == 3.0,
    }
    assert all(checks.values()), f"Official benchmark mismatch: {checks}"
    output = {
        "schema_version": "1.0",
        "source": "AHRQ MEPS HC-254G + HC-256",
        "year": 2024,
        "status": "computed_from_public_microdata",
        "accessed": args.access_date,
        "population": "Office-based visits, all ages, U.S. civilian noninstitutionalized population",
        "unit": "visit",
        "provenance": provenance,
        "documentation": [
            {"title": "HC-254G documentation", "url": DOC_EVENT},
            {"title": "HC-256 documentation", "url": DOC_PERSON},
        ],
        "methods": {
            "weight": "PERWT24F",
            "stratum": "VARSTR",
            "psu": "VARPSU",
            "estimator": "Survey-weighted ratio means; with-replacement Taylor linearization",
            "confidence_interval": "95% normal approximation: estimate +/- 1.959964 SE; clipped to [0,100] for percentages and to zero below for payments",
            "variance_domains": "The complete positive-weight HC-256 PSU universe is retained; out-of-domain PSUs contribute zero influence.",
            "strata": len(psus),
            "psus": sum(len(x) for x in psus.values()),
            "design_df": sum(len(x) - 1 for x in psus.values()),
            "insurance_variable": "INSCOV24",
            "insurance_definition": "Any private includes TRICARE/CHAMPVA at any time in 2024; public only has no private coverage; uninsured means uninsured all year. Categories describe annual coverage, not coverage on the visit date.",
            "share_denominator": "All positive-weight office visits within the selected insurance group, including remote visits with unknown modality",
            "payment_denominator": "Positive-weight visits in each displayed modality/insurance group; zero payments retained",
            "payment_units": "2024 U.S. dollars per visit; released imputed values retained",
            "stability_rule": "Dashboard screening rule (not an official AHRQ release standard): flag fewer than 30 sampled persons in a payment domain, modality numerator, or telehealth numerator, RSE > 30%, or boundary proportions. Withhold those small-person-count estimates from the interface and display-ready CSV; preserve computed estimates in aggregate JSON.",
            "interpretation": "Descriptive, unadjusted comparisons; no causal or predictive interpretation. No patient-level linkage to NHIS.",
        },
        "quality": {
            "source_event_n": len(events),
            "source_person_n": len(people),
            "analytic_visit_n": len(eligible),
            "analytic_person_n": len({r["DUPERSID"] for r in eligible}),
            "zero_weight_visit_n": sum(r["PERWT24F"] == 0 for r in events),
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
                r["OBXP24X"] < 0 or r["OBSF24X"] < 0 for r in events
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
