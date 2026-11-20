# HINF 5001 Team 1: prediction of past-year telehealth use (NHIS)

Development on NHIS 2024 Sample Adult data; temporal validation on NHIS 2025.

| Path | Contents |
|---|---|
| `nhis_telehealth_prediction_final.Rmd` | Full analysis code, from raw NHIS files to all results |
| `nhis_telehealth_prediction_final.html` | Knitted output with every table, figure and printed result |
| `figures/study_design.png`, `.pdf` | Study design diagram |
| `model_export/` | Fitted models (coefficients, spline knots, factor levels, coding dictionary, XGBoost model) and a scoring function; see its README |
| `supplementary/variable_screening.csv` | Screening decision and reason for every item in the 2024 file |
| `supplementary/codebook_verification.csv` | Item-by-item check of codes, labels and universes against the 2024 and 2025 codebooks |

## Reproducing

Download the 2024 and 2025 NHIS Sample Adult CSV files (`adult24.csv`,
`adult25.csv`) from the National Center for Health Statistics and place
them next to the Rmd, then knit. A full run takes about 2 hours on 2–4
cores. Raw data are not included in this repository.
