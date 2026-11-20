<!-- author: Yao Yao(yay4008@med.cornell.edu) -->

# NHIS model development and validation

The primary model estimates whether a US adult reported a phone or video appointment in the previous 12 months. Development used 25,500 NHIS 2024 Sample Adult respondents. The 2024 holdout contained 6,377 respondents and the 2025 evaluation contained 23,605. The outcome and predictors come from the same interview. The 2025 respondents form a new cross-sectional sample.

## Analysis materials

- [Rendered research report](nhis_telehealth_prediction_final.html) with the study methods, full results, sensitivity analyses, model export checks and session information.
- [R Markdown analysis](nhis_telehealth_prediction_final.Rmd) with the source for model fitting, evaluation and coefficient export.
- [Study design diagram (PNG)](figures/study_design.png) and [printable diagram (PDF)](figures/study_design.pdf). Earlier analyses of the holdout samples informed the final study design.
- [Variable screening decisions](supplementary/variable_screening.csv) and [codebook verification](supplementary/codebook_verification.csv). The verification table documents the home Internet access item and five coding corrections.

## Models and scoring

| File                                                                                                                                   | Use                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [Model coefficients](model_export/model_coefficients.csv)                                                                              | Logistic model intercepts and log-odds coefficients with conditional standard errors, and nonzero penalized group-lasso coefficients |
| [Spline knots](model_export/spline_knots.csv)                                                                                          | Training-sample interior and boundary knots for the age and income-to-poverty natural splines                                        |
| [Factor levels](model_export/factor_levels.csv)                                                                                        | Ordered category labels and reference levels                                                                                         |
| [Coding dictionary](model_export/coding_dictionary.csv)                                                                                | Raw NHIS codes, missing-value rules, structural skips and derived categories                                                         |
| [R scoring function](model_export/predict_from_csv.R)                                                                                  | Reconstructs logistic and group-lasso scores from already coded inputs and the exported coefficients                                 |
| [XGBoost model](model_export/xgb_full_pool.json), [features](model_export/xgb_features.csv), [settings](model_export/xgb_settings.csv) | Saved booster, R design-matrix column order, and tuning configuration                                                                |

The baseline models were fitted without survey weights. Performance is reported with and without the original survey weights for respondents who met the common complete-case criteria. Exact category labels, age in years, and a common income-to-poverty cap of 11 are required for coefficient-based scoring. The model export check compares reconstructed 2025 scores with predictions from the original fitted models.

## Reproduce the research report

Obtain the public Sample Adult CSV files from the [2024 NHIS release](https://www.cdc.gov/nchs/nhis/documentation/2024-nhis.html) and the [2025 NHIS release](https://www.cdc.gov/nchs/nhis/documentation/2025-nhis.html). Extract `adult24.csv` and `adult25.csv` together outside the publish directory. Set the environment variable `NHIS_DATA_DIR` to that directory, or place the two files next to the R Markdown source during a local analysis.

From this directory, render the R Markdown file with the Knit command in RStudio or the command below. Install R, Pandoc and the R packages `rmarkdown`, `knitr`, `xgboost`, `PRROC`, `survey` and `grpreg` first. The report records the versions used to produce the supplied run. A full run on two to four cores takes approximately two hours and refreshes the model exports and screening table.

<!-- author: Yao Yao(yay4008@med.cornell.edu) -->

```sh
Rscript -e 'rmarkdown::render("nhis_telehealth_prediction_final.Rmd")'
```

The dashboard displays the aggregate metrics from this analysis.
