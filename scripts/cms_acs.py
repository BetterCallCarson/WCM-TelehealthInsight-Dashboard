#!/usr/bin/env python3
# Author: Jiajun (Carson) Chen
# email: jic4015@med.cornell.edu
"""Build the descriptive CMS + ACS module from pinned official public files.

Usage: python3 scripts/cms_acs.py [--download] [--access-date YYYY-MM-DD]
No third-party Python packages or Census API key are required. The default uses
cached files in .work/ and downloads missing ones. --download replaces caches.
Source hashes are checked before use; a changed release requires deliberate review.
"""

import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import ssl
import statistics
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / ".work"
OUT = ROOT / "data" / "cms.json"
SNAPSHOT_ACCESS_DATE = "2026-11-11"
YEARS = list(range(2020, 2026))
CMS_LANDING = "https://data.cms.gov/summary-statistics-on-use-and-payments/medicare-medicaid-service-type-reports/medicare-telehealth-trends"
CMS_DICTIONARY = "https://data.cms.gov/data-api/v1/dataset/21e3fb54-7f6c-4de9-9731-027213c2cdb3/dictionary"
ACS_BASE = "https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/1YRData/"
MOE_METHOD = "https://www2.census.gov/programs-surveys/acs/tech_docs/statistical_testing/2024_Instructions_for_Stat_Testing_ACS.pdf"
SOURCES = [
    {
        "id": "cms",
        "title": "CMS Medicare Telehealth Trends",
        "filename": "cms_source.csv",
        "url": "https://data.cms.gov/sites/default/files/2026-09/TMEDTREND_PUBLIC_260914.csv",
        "sha256": "09e80f29d3b5825a88c1d04a2a71681142dadb5f06eb90805e9397afee3f37c0",
        "releaseDate": "2026-09-17",
        "coverage": "2020 Q1–2026 Q1; dashboard retains 2020–2025",
        "landingUrl": CMS_LANDING,
        "dictionaryUrl": CMS_DICTIONARY,
    },
    {
        "id": "acs_b28002",
        "title": "2024 ACS 1-year B28002 Internet subscriptions",
        "filename": "cms_acs_b28002.dat",
        "url": ACS_BASE + "acsdt1y2024-b28002.dat",
        "sha256": "ac6ff542ba9778fce91895dd6c611e0cb22be32696b124e063d93f5e4d73e8e2",
        "releaseDate": "2025-09-11",
        "coverage": "2024",
        "dictionaryUrl": "https://api.census.gov/data/2024/acs/acs1/groups/B28002.html",
    },
    {
        "id": "acs_b19013",
        "title": "2024 ACS 1-year B19013 Median household income",
        "filename": "cms_acs_b19013.dat",
        "url": ACS_BASE + "acsdt1y2024-b19013.dat",
        "sha256": "f78748dc0221551890494e08d8239d7aecbfff9777e96a18d24f5df6a570cd86",
        "releaseDate": "2025-09-11",
        "coverage": "2024",
        "dictionaryUrl": "https://api.census.gov/data/2024/acs/acs1/groups/B19013.html",
    },
]

# Standard state FIPS crosswalk; the explicit allowlist excludes territories.
STATE_TEXT = """01|AL|Alabama
02|AK|Alaska
04|AZ|Arizona
05|AR|Arkansas
06|CA|California
08|CO|Colorado
09|CT|Connecticut
10|DE|Delaware
11|DC|District of Columbia
12|FL|Florida
13|GA|Georgia
15|HI|Hawaii
16|ID|Idaho
17|IL|Illinois
18|IN|Indiana
19|IA|Iowa
20|KS|Kansas
21|KY|Kentucky
22|LA|Louisiana
23|ME|Maine
24|MD|Maryland
25|MA|Massachusetts
26|MI|Michigan
27|MN|Minnesota
28|MS|Mississippi
29|MO|Missouri
30|MT|Montana
31|NE|Nebraska
32|NV|Nevada
33|NH|New Hampshire
34|NJ|New Jersey
35|NM|New Mexico
36|NY|New York
37|NC|North Carolina
38|ND|North Dakota
39|OH|Ohio
40|OK|Oklahoma
41|OR|Oregon
42|PA|Pennsylvania
44|RI|Rhode Island
45|SC|South Carolina
46|SD|South Dakota
47|TN|Tennessee
48|TX|Texas
49|UT|Utah
50|VT|Vermont
51|VA|Virginia
53|WA|Washington
54|WV|West Virginia
55|WI|Wisconsin
56|WY|Wyoming"""
STATES = [
    dict(zip(("fips", "abbr", "name"), line.split("|")))
    for line in STATE_TEXT.splitlines()
]


def source_file(source, force=False):
    """Obtains a pinned source and verifies its bytes before analysis.

    Args:
        source: Source specification with filename, URL, and expected SHA-256.
        force: Whether to fetch again even when a cached copy exists.

    Returns:
        A tuple of the local Path and a boolean indicating a fresh download.

    Raises:
        ValueError: The downloaded or cached bytes do not match the pinned hash.
        OSError: The verified file cannot be retrieved or written.
    """
    path = WORK / source["filename"]
    fetched = force or not path.exists()
    if fetched:
        request = urllib.request.Request(
            source["url"],
            headers={"User-Agent": "CHERY-Lab-Telehealth-Dashboard/1.0"},
        )
        context = ssl.create_default_context()
        # macOS Python.org installs may not include their own CA bundle. Add
        # the operating-system CA file when present, retaining verification.
        system_ca = Path("/etc/ssl/cert.pem")
        if system_ca.exists():
            context.load_verify_locations(cafile=str(system_ca))
        with urllib.request.urlopen(
            request, timeout=90, context=context
        ) as response:
            payload = response.read()
        digest = hashlib.sha256(payload).hexdigest()
        if digest != source["sha256"]:
            raise ValueError(
                f"Source changed: {source['id']} hash {digest}; review the source before updating the pin"
            )
        path.write_bytes(payload)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != source["sha256"]:
        raise ValueError(f"Cached source failed SHA-256 validation: {path}")
    return path, fetched


def number(value):
    """Parses a source cell while preserving missingness.

    Args:
        value: Raw numeric cell, including blanks or agency sentinel values.

    Returns:
        A nonnegative finite int/float, or None for missing/invalid values.
        Census negative sentinels and suppression symbols are never treated as zero.
    """
    try:
        result = float(value)
    except (ValueError, TypeError):
        return None
    if not math.isfinite(result) or result < 0:
        return None
    return int(result) if result.is_integer() else result


def cms_record(row):
    """Normalizes a published annual or quarterly CMS row.

    Args:
        row: CSV row containing counts, a fractional rate, and reporting period.

    Returns:
        A dashboard record with percentage units and an independent count ratio.
        Annual values come from Overall records, never summed quarterly users.

    Raises:
        ValueError: The published rate is outside the expected fraction scale.
    """
    year = int(row["Year"])
    annual = row["quarter"] == "Overall"
    quarter = None if annual else int(row["quarter"])
    rate = number(row["Pct_Telehealth"])
    if rate is not None and not 0 <= rate <= 1:
        raise ValueError(
            "CMS percentage source scale changed; expected a fraction"
        )
    users = number(row["Total_Bene_Telehealth"])
    eligible = number(row["Total_Bene_TH_Elig"])
    recalculated = (
        100 * users / eligible if users is not None and eligible else None
    )
    pct = round(100 * rate, 6) if rate is not None else None
    if (
        recalculated is not None
        and pct is not None
        and abs(recalculated - pct) > 0.005001
    ):
        raise ValueError(
            f"CMS published rate fails independent numerator/denominator check: {row}"
        )
    return {
        "year": year,
        "quarter": quarter,
        "period": str(year) if annual else f"{year} Q{quarter}",
        "telehealthPct": pct,
        "telehealthUsers": users,
        "eligibleUsers": eligible,
        "partBEnrollment": number(row["Total_PartB_Enrl"]),
        "recalculatedPct": (
            round(recalculated, 8) if recalculated is not None else None
        ),
        "status": "available" if pct is not None else "suppressed_or_missing",
    }


def acs_table(path):
    """Reads state-level rows from an ACS pipe-delimited table.

    Args:
        path: Local table-based summary-file Path.

    Returns:
        A tuple of all source rows and a mapping of two-digit state FIPS
        strings to state rows.
    """
    with path.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle, delimiter="|"))
    state_rows = {
        r["GEO_ID"][-2:]: r
        for r in rows
        if r["GEO_ID"].startswith("0400000US") and len(r["GEO_ID"]) == 11
    }
    return rows, state_rows


def acs_record(broadband, income):
    """Derives household context and its approximate 90% uncertainty.

    Args:
        broadband: State B28002 row with household estimates and margins of error.
        income: State B19013 row with median income and its margin of error.

    Returns:
        Broadband percent, income in dollars, counts, and MOE metadata. The
        subset-proportion MOE uses the ratio fallback when its radicand is negative.
    """
    total, numerator = number(broadband["B28002_E001"]), number(
        broadband["B28002_E004"]
    )
    total_moe, numerator_moe = number(broadband["B28002_M001"]), number(
        broadband["B28002_M004"]
    )
    median, median_moe = number(income["B19013_E001"]), number(
        income["B19013_M001"]
    )
    proportion = numerator / total if numerator is not None and total else None
    if proportion is not None and not 0 <= proportion <= 1:
        raise ValueError("Invalid ACS broadband proportion")
    moe = None
    method = None
    if (
        proportion is not None
        and total_moe is not None
        and numerator_moe is not None
    ):
        radical = numerator_moe**2 - proportion**2 * total_moe**2
        method = "subset_proportion"
        if proportion == 1:
            radical = numerator_moe**2
        elif radical < 0:
            radical = numerator_moe**2 + proportion**2 * total_moe**2
            method = "ratio_fallback"
        moe = math.sqrt(radical) / total * 100
    return {
        "year": 2024,
        "broadbandPct": (
            round(proportion * 100, 6) if proportion is not None else None
        ),
        "households": total,
        "broadbandHouseholds": numerator,
        "medianIncome": median,
        "incomeMoe90": median_moe,
        "broadbandMoe90": round(moe, 6) if moe is not None else None,
        "broadbandMoeMethod": method,
        "broadbandNumeratorMoe90": numerator_moe,
        "householdMoe90": total_moe,
    }


def matrix_inverse(matrix):
    """Inverts a small square matrix using partial-pivot Gauss-Jordan elimination.

    Args:
        matrix: Square numeric list of rows; caller data are copied before mutation.

    Returns:
        The inverse matrix as a new list of rows.

    Raises:
        ValueError: A pivot is too small for the fitted design to be invertible.
    """
    size = len(matrix)
    augmented = [
        list(map(float, row)) + [float(i == j) for j in range(size)]
        for i, row in enumerate(matrix)
    ]
    for column in range(size):
        pivot = max(
            range(column, size), key=lambda r: abs(augmented[r][column])
        )
        if abs(augmented[pivot][column]) < 1e-12:
            raise ValueError("State model design is singular")
        augmented[column], augmented[pivot] = (
            augmented[pivot],
            augmented[column],
        )
        scale = augmented[column][column]
        augmented[column] = [value / scale for value in augmented[column]]
        for row in range(size):
            if row != column:
                factor = augmented[row][column]
                augmented[row] = [
                    a - factor * b
                    for a, b in zip(augmented[row], augmented[column])
                ]
    return [row[size:] for row in augmented]


def adjusted_state_model(complete):
    """Fits equal-state OLS with HC3 covariance and normal confidence intervals.

    Args:
        complete: Pairs of (state dictionary, annual CMS record), with
            complete ACS 2024 covariates.

    Returns:
        Coefficients, HC3 standard errors, 95% normal intervals, fit diagnostics,
        and interpretation notes. Income is scaled per $10,000; the outcome is
        percentage points. These ecological associations are not predictions.

    Raises:
        ValueError: The predictor matrix is singular, leverage is invalid,
            or residual orthogonality fails the numerical tolerance.
    """
    x = [
        [
            1.0,
            s["acs2024"]["broadbandPct"],
            s["acs2024"]["medianIncome"] / 10000.0,
        ]
        for s, _ in complete
    ]
    y = [a["telehealthPct"] for _, a in complete]
    n, parameters = len(y), 3
    inverse = matrix_inverse(
        [
            [math.fsum(row[i] * row[j] for row in x) for j in range(parameters)]
            for i in range(parameters)
        ]
    )
    xty = [
        math.fsum(row[j] * outcome for row, outcome in zip(x, y))
        for j in range(parameters)
    ]
    beta = [
        math.fsum(inverse[i][j] * xty[j] for j in range(parameters))
        for i in range(parameters)
    ]
    residual = [
        outcome - math.fsum(a * b for a, b in zip(row, beta))
        for row, outcome in zip(x, y)
    ]
    leverages = [
        math.fsum(
            row[i] * inverse[i][j] * row[j]
            for i in range(parameters)
            for j in range(parameters)
        )
        for row in x
    ]
    if any(not 0 <= h < 1 for h in leverages):
        raise ValueError("Invalid OLS leverage")
    meat = [
        [
            math.fsum(
                row[i] * row[j] * (error / (1 - h)) ** 2
                for row, error, h in zip(x, residual, leverages)
            )
            for j in range(parameters)
        ]
        for i in range(parameters)
    ]
    covariance = [
        [
            math.fsum(
                inverse[i][k] * meat[k][m] * inverse[m][j]
                for k in range(parameters)
                for m in range(parameters)
            )
            for j in range(parameters)
        ]
        for i in range(parameters)
    ]
    normal_equation_error = max(
        abs(math.fsum(row[j] * error for row, error in zip(x, residual)))
        for j in range(parameters)
    )
    if normal_equation_error > 1e-5:
        raise ValueError("OLS residual orthogonality check failed")
    sse = math.fsum(error**2 for error in residual)
    sst = math.fsum((outcome - statistics.mean(y)) ** 2 for outcome in y)
    labels = [
        (
            "intercept",
            "Intercept",
            "percentage points at zero broadband and zero income; outside the observed range",
        ),
        (
            "broadbandPct",
            "Broadband subscription, per 1 percentage point",
            "telehealth percentage points per 1 percentage-point higher broadband subscription",
        ),
        (
            "medianIncomePer10000",
            "Median household income, per $10,000",
            "telehealth percentage points per $10,000 higher median household income",
        ),
    ]
    terms = []
    for i, (term, label, units) in enumerate(labels):
        se = math.sqrt(covariance[i][i])
        terms.append(
            {
                "term": term,
                "label": label,
                "units": units,
                "estimate": round(beta[i], 8),
                "se": round(se, 8),
                "ciLow": round(beta[i] - 1.959963984540054 * se, 8),
                "ciHigh": round(beta[i] + 1.959963984540054 * se, 8),
            }
        )
    return {
        "status": "computed",
        "model": "Unweighted state-level ordinary least squares",
        "formula": "2024 annual telehealthPct ~ broadbandPct + medianIncome / 10000",
        "year": 2024,
        "n": n,
        "excludedStates": 51 - n,
        "parameters": parameters,
        "residualDf": n - parameters,
        "outcomeUnits": "CMS annual telehealth percentage points",
        "coefficients": terms,
        "covariance": "HC3 heteroskedasticity-robust sandwich covariance",
        "confidenceInterval": "Approximate 95% normal interval: coefficient +/- 1.959964 × HC3 SE; not a t interval",
        "rSquared": round(1 - sse / sst, 8),
        "adjustedRSquared": round(
            1 - (sse / (n - parameters)) / (sst / (n - 1)), 8
        ),
        "maximumLeverage": round(max(leverages), 8),
        "normalEquationMaxAbsoluteError": normal_equation_error,
        "notes": [
            "States and DC receive equal weight; ACS is matched only to 2024 CMS annual records.",
            "Both covariates enter simultaneously. Broadband is measured in percentage points and income in $10,000 units.",
            "HC3 addresses heteroskedasticity, not spatial dependence, confounding, or ACS measurement error.",
            "This is an ecological observational association; state household context is not individual beneficiary exposure.",
            "Linear functional form, influential-state sensitivity, spatial residuals, and alternative specifications have not been evaluated.",
            "R-squared describes fit in these 51 observations; it is not a measure of predictive performance. No forecasts or individual predictions are generated.",
        ],
    }


def main():
    """Builds the pinned CMS/ACS aggregate and provenance record.

    Command-line options control cache refresh and retrieval-date metadata.
    Source matching and count checks run before the aggregate JSON is written.
    The matched-year model always uses 2024, even when trend years differ.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--download",
        action="store_true",
        help="Download pinned sources again, verifying their hashes",
    )
    parser.add_argument(
        "--access-date",
        help="Explicit ISO source access date; defaults to download date or snapshot date for cached reproduction",
    )
    args = parser.parse_args()
    WORK.mkdir(parents=True, exist_ok=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    files = {}
    fetched_any = False
    for source in SOURCES:
        path, fetched = source_file(source, args.download)
        files[source["id"]] = path
        fetched_any |= fetched
    access_date = args.access_date or (
        dt.date.today().isoformat() if fetched_any else SNAPSHOT_ACCESS_DATE
    )
    dt.date.fromisoformat(access_date)

    with files["cms"].open(encoding="utf-8-sig", newline="") as handle:
        raw = list(csv.DictReader(handle))
    subgroup_columns = [
        key
        for key in raw[0]
        if key.startswith("Bene_") and key != "Bene_Geo_Desc"
    ]
    # Require every published subgroup to be All to prevent double counting.
    all_rows = [
        r for r in raw if all(r[key] == "All" for key in subgroup_columns)
    ]
    allowed_names = {s["name"].casefold() for s in STATES} | {"national"}
    retained = [
        r
        for r in all_rows
        if int(r["Year"]) in YEARS
        and r["Bene_Geo_Desc"].casefold() in allowed_names
    ]
    keys = [
        (r["Year"], r["quarter"], r["Bene_Geo_Desc"].casefold())
        for r in retained
    ]
    if len(keys) != len(set(keys)):
        raise ValueError("Duplicate year-quarter-state keys in CMS source")
    if len(retained) != 52 * len(YEARS) * 5:
        raise ValueError(
            f"Incomplete CMS coverage: expected 1560 rows, found {len(retained)}"
        )
    grouped = {}
    for row in retained:
        geo = row["Bene_Geo_Desc"].casefold()
        kind = "annual" if row["quarter"] == "Overall" else "quarterly"
        grouped.setdefault(geo, {"annual": [], "quarterly": []})[kind].append(
            cms_record(row)
        )
    for series in grouped.values():
        for kind in series:
            series[kind].sort(key=lambda r: (r["year"], r["quarter"] or 0))
    broadband_raw, broadband = acs_table(files["acs_b28002"])
    income_raw, income = acs_table(files["acs_b19013"])
    states = []
    for state in STATES:
        fips = state["fips"]
        if fips not in broadband or fips not in income:
            raise ValueError(f"Missing ACS state: {state['name']}")
        states.append(
            {
                **state,
                **grouped[state["name"].casefold()],
                "acs2024": acs_record(broadband[fips], income[fips]),
            }
        )
    states.sort(key=lambda s: s["name"])
    paired = [
        (s, next(x for x in s["annual"] if x["year"] == 2024)) for s in states
    ]
    complete = [
        (s, a)
        for s, a in paired
        if a["telehealthPct"] is not None
        and s["acs2024"]["broadbandPct"] is not None
        and s["acs2024"]["medianIncome"] is not None
    ]
    rates = [a["telehealthPct"] for _, a in complete]
    output = {
        "schemaVersion": 1,
        "status": "ready",
        "accessDate": access_date,
        "title": "Medicare telehealth use and state context",
        "years": YEARS,
        "national": grouped["national"],
        "states": states,
        "associations": {
            "year": 2024,
            "n": len(complete),
            "method": "Unweighted Pearson correlation across states and DC; descriptive only",
            "broadbandPearsonR": round(
                statistics.correlation(
                    [s["acs2024"]["broadbandPct"] for s, _ in complete], rates
                ),
                6,
            ),
            "incomePearsonR": round(
                statistics.correlation(
                    [s["acs2024"]["medianIncome"] for s, _ in complete], rates
                ),
                6,
            ),
            "limitation": "The Pearson correlations are unadjusted ecological associations. The separate adjustedModel includes broadband and income only; neither analysis supports individual-level or causal interpretation.",
            "adjustedModel": adjusted_state_model(complete),
        },
        "quality": {
            "cmsSourceRows": len(raw),
            "cmsAllSubgroupRows": len(all_rows),
            "cmsRetainedRows": len(retained),
            "cmsStateAnnualRows": 51 * len(YEARS),
            "cmsStateQuarterlyRows": 51 * len(YEARS) * 4,
            "cmsNationalRows": len(YEARS) * 5,
            "cmsExcludedRows": len(raw) - len(retained),
            "cmsDuplicateKeys": len(keys) - len(set(keys)),
            "cmsMissingRatesRetained": sum(
                r["Pct_Telehealth"].strip() == "" for r in retained
            ),
            "cmsMissingCountsRetained": {
                field: sum(number(r[field]) is None for r in retained)
                for field in (
                    "Total_Bene_TH_Elig",
                    "Total_Bene_Telehealth",
                    "Total_PartB_Enrl",
                )
            },
            "cmsRateValidationTolerancePercentagePoints": 0.005001,
            "cmsMaximumRateDiscrepancyPercentagePoints": round(
                max(
                    abs(
                        100 * float(r["Pct_Telehealth"])
                        - 100
                        * float(r["Total_Bene_Telehealth"])
                        / float(r["Total_Bene_TH_Elig"])
                    )
                    for r in retained
                    if all(
                        number(r[k]) is not None
                        for k in (
                            "Pct_Telehealth",
                            "Total_Bene_Telehealth",
                            "Total_Bene_TH_Elig",
                        )
                    )
                ),
                8,
            ),
            "acsBroadbandSourceRows": len(broadband_raw),
            "acsIncomeSourceRows": len(income_raw),
            "acsStateRowsIncludingPuertoRico": len(broadband),
            "acsRetainedStates": len(states),
            "cmsAcsMatched2024States": len(complete),
            "acsMissingRetained": {
                field: sum(s["acs2024"][field] is None for s in states)
                for field in (
                    "broadbandPct",
                    "medianIncome",
                    "incomeMoe90",
                    "broadbandMoe90",
                )
            },
            "checksPassed": [
                "Pinned source SHA-256 verified",
                "Unique CMS year-quarter-state keys",
                "Complete 2020–2025 annual and quarterly coverage",
                "All subgroup dimensions equal All",
                "CMS rates independently recalculated from counts",
                "51 state/DC ACS matches",
                "No negative Census sentinel values used as numeric estimates",
            ],
        },
        "sources": [
            {
                **source,
                "accessDate": access_date,
                "bytes": files[source["id"]].stat().st_size,
            }
            for source in SOURCES
        ],
        "definitions": {
            "population": "CMS: Medicare Part B fee-for-service service users. ACS: all households in each state and DC, not Medicare beneficiaries.",
            "telehealthPct": "100 × unique beneficiaries receiving at least one telehealth service / unique beneficiaries receiving at least one telehealth-eligible service. Includes audio-only telehealth. Published fraction multiplied by 100.",
            "eligibleUsers": "Unique beneficiaries receiving a telehealth-eligible service in that reporting period, including in-person services. This is the rate denominator.",
            "partBEnrollment": "Published person-year/person-quarter Part B FFS enrollment measure; not used as the telehealth rate denominator.",
            "annual": "CMS quarter=Overall records count unique users across the year. Annual counts/rates are not sums or means of quarterly values.",
            "quarterly": "Separate quarterly reporting periods; a beneficiary can appear in more than one quarter.",
            "broadbandPct": "2024 ACS 1-year B28002_004E / B28002_001E × 100: households with broadband of any type, including cellular-only subscriptions, divided by all households. Subscription is not equivalent to speed, reliability, or digital literacy.",
            "medianIncome": "2024 ACS 1-year B19013_001E; median household income in 2024 inflation-adjusted US dollars.",
            "acsVariableNames": "Table-based fields B28002_E004, B28002_E001, B19013_E001 correspond to API fields B28002_004E, B28002_001E, B19013_001E.",
            "uncertainty": "CMS administrative aggregates have no survey sampling confidence interval supplied. ACS margins of error use the published 90% confidence level.",
            "broadbandMoe90": "Derived approximate 90% margin of error, percentage points: 100 × sqrt(MOE_numerator² − p² × MOE_denominator²) / denominator. Use plus if the radicand is negative. Source: "
            + MOE_METHOD,
            "national": "CMS published National aggregate is retained as supplied; it is not reconstructed by summing the 50 states and DC and can include other geographic categories.",
            "missing": "Blank/suppressed/non-numeric CMS values and negative ACS sentinel values map to null, never zero. All selected source values in this snapshot are available.",
            "yearMatching": "ACS is matched only to 2024 CMS annual records. No ACS values are extrapolated to other years.",
        },
        "limitations": [
            "State geography follows beneficiary mailing address. The mapped population is Medicare Part B FFS, not the entire US population.",
            "CMS and ACS describe different populations; state-level context does not identify individual broadband access or income.",
            "Changes in enrollment, reimbursement policy, coding and service eligibility can affect observed trends.",
            "The snapshot uses a later CMS release than the original milestone documentation; historical values may have been revised.",
            "Suppression rules apply to the underlying CMS release. No suppressed values are reconstructed.",
            "The adjusted state regression includes broadband and income only; unmeasured confounding and ecological bias remain. No prediction or causal model is reported.",
        ],
    }
    OUT.write_text(
        json.dumps(output, indent=2, ensure_ascii=False, allow_nan=False)
        + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "output": str(OUT),
                "states": len(states),
                "cmsRows": len(retained),
                "acsMatchedStates": len(complete),
                "national2024": next(
                    r
                    for r in grouped["national"]["annual"]
                    if r["year"] == 2024
                ),
                "quality": output["quality"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
