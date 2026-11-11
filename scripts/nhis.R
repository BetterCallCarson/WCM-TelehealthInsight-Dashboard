# Author: Jiajun (Carson) Chen
# email: jic4015@med.cornell.edu
# Survey-weighted NHIS 2024 descriptive estimates and adjusted associations.
# This script does not generate predictions or measure predictive performance.
# Run through scripts/nhis.py, which downloads and fingerprints the source.
args <- commandArgs(trailingOnly = TRUE)
root <- if (length(args)) normalizePath(args[[1]]) else normalizePath(".")
local_lib <- file.path(root, ".work", "nhis-R-library")
if (dir.exists(local_lib)) .libPaths(c(local_lib, .libPaths()))
if (!requireNamespace("survey", quietly = TRUE) || !requireNamespace("jsonlite", quietly = TRUE)) {
  stop("Install the R packages survey and jsonlite before running this script.")
}
suppressPackageStartupMessages(library(survey))
options(survey.lonely.psu = "fail")
data <- read.csv(file.path(root, ".work", "nhis", "adult24.csv"), stringsAsFactors = FALSE)
required <- c("WTFA_A", "PSTRAT", "PPSU", "VIRAPP12M_A", "NOTCOV_A", "PRIVATE_A", "AGEP_A", "EDUCP_A", "ACCSSINT_A", "PHSTAT_A")
stopifnot(all(required %in% names(data)), nrow(data) == 32629L)
stopifnot(all(is.finite(data$WTFA_A)), all(data$WTFA_A > 0), !anyNA(data$PSTRAT), !anyNA(data$PPSU))
data$telehealth <- ifelse(data$VIRAPP12M_A %in% c(1, 2), as.numeric(data$VIRAPP12M_A == 1), NA_real_)
stopifnot(sum(is.na(data$telehealth)) == 305L, sum(data$telehealth == 1, na.rm = TRUE) == 8293L)

# Edited coverage recodes are used; HICOV_A and HIKIND* are unedited responses.
# PRIVATE_A codes 1 AND 2 are yes; 3 is no (not a 1/2 yes/no variable).
data$insurance <- NA_character_
data$insurance[data$NOTCOV_A == 1] <- "Uninsured"
data$insurance[data$NOTCOV_A == 2 & data$PRIVATE_A %in% c(1, 2)] <- "Any private coverage"
data$insurance[data$NOTCOV_A == 2 & data$PRIVATE_A == 3] <- "Public / other, no private"
data$insurance_coverage <- ifelse(data$NOTCOV_A == 1, "Uninsured", ifelse(data$NOTCOV_A == 2, "Insured", NA_character_))
data$age <- as.character(cut(ifelse(data$AGEP_A >= 18 & data$AGEP_A <= 85, data$AGEP_A, NA_real_), breaks = c(18, 35, 50, 65, Inf), right = FALSE, labels = c("18–34", "35–49", "50–64", "65+")))
data$education <- NA_character_
data$education[data$EDUCP_A %in% 0:2] <- "Less than high school"
data$education[data$EDUCP_A %in% 3:4] <- "High school / GED"
data$education[data$EDUCP_A %in% 5:7] <- "Some college / associate"
data$education[data$EDUCP_A %in% 8:10] <- "Bachelor’s or higher"
data$internet <- ifelse(data$ACCSSINT_A == 1, "Internet access", ifelse(data$ACCSSINT_A == 2, "No Internet access", NA_character_))
health_labels <- c("Excellent", "Very good", "Good", "Fair", "Poor")
data$health <- ifelse(data$PHSTAT_A %in% 1:5, health_labels[pmin(data$PHSTAT_A, 5)], NA_character_)
data$age_numeric <- ifelse(data$AGEP_A >= 18 & data$AGEP_A <= 85, data$AGEP_A, NA_real_)
data$insurance_model <- factor(data$insurance, levels = c("Any private coverage", "Public / other, no private", "Uninsured"))
data$education_model <- factor(data$education, levels = c("Bachelor’s or higher", "Less than high school", "High school / GED", "Some college / associate"))
data$internet_model <- factor(data$internet, levels = c("Internet access", "No Internet access"))
data$health_model <- factor(data$health, levels = health_labels)
model_variables <- c("telehealth", "insurance_model", "age_numeric", "education_model", "internet_model", "health_model")
data$model_complete <- complete.cases(data[, model_variables])

# Build the design before domain subsetting, as directed by NCHS.
design <- svydesign(ids = ~PPSU, strata = ~PSTRAT, weights = ~WTFA_A, data = data, nest = TRUE)
strata_sizes <- tapply(data$PPSU, data$PSTRAT, function(x) length(unique(x)))
stopifnot(all(strata_sizes > 1))
audit_errors <- numeric()

# Independent calculation of the Taylor variance of a domain ratio. All original
# PSUs remain present, including zero-contribution PSUs outside the domain.
# Args: domain is a full-length logical mask; estimate is a 0–1 domain mean.
# Returns: Taylor-linearized SE on the fraction scale, retaining all PSUs.
# Reads the full data design; does not fit or modify survey objects.
independent_se <- function(domain, estimate) {
  residual <- rep(0, nrow(data))
  total_weight <- sum(data$WTFA_A[domain])
  residual[domain] <- data$WTFA_A[domain] * (data$telehealth[domain] - estimate) / total_weight
  totals <- aggregate(residual, list(stratum = data$PSTRAT, psu = data$PPSU), sum)
  by_stratum <- split(totals$x, totals$stratum)
  sqrt(sum(vapply(by_stratum, function(z) length(z) / (length(z) - 1) * sum((z - mean(z))^2), numeric(1))))
}

# Args: mask selects a population group; label names the reported domain.
# Returns: weighted percent, logit 95% interval, sample support, and missingness.
# Missing masks become FALSE; only outcome nonresponse is excluded within a group.
# Side effect: appends independent arithmetic discrepancies to audit_errors.
estimate_domain <- function(mask, label) {
  mask[is.na(mask)] <- FALSE
  domain <- mask & !is.na(data$telehealth)
  selected <- subset(design, domain)
  est <- svymean(~telehealth, selected)
  p <- as.numeric(coef(est))
  se <- as.numeric(SE(est))
  ci <- as.numeric(confint(svyciprop(~telehealth, selected, method = "logit", df = degf(selected))))
  p_check <- sum(data$WTFA_A[domain] * data$telehealth[domain]) / sum(data$WTFA_A[domain])
  se_check <- independent_se(domain, p_check)
  audit_errors <<- c(audit_errors, abs(p - p_check), abs(se - se_check))
  stopifnot(abs(p - p_check) < 1e-10, abs(se - se_check) < 1e-10, ci[1] <= p, ci[2] >= p)
  n <- sum(domain)
  relative_se <- if (p > 0) se / p else Inf
  unstable <- n < 30 || !is.finite(relative_se) || relative_se > .30
  list(
    label = label, n = n, raw_group_n = sum(mask), missing_outcome_n = sum(mask & is.na(data$telehealth)),
    yes_n = sum(data$telehealth[domain] == 1), weighted_denominator = sum(data$WTFA_A[domain]),
    estimate = p * 100, ci_low = ci[1] * 100, ci_high = ci[2] * 100,
    standard_error = se * 100, relative_standard_error = relative_se,
    unstable = unstable, suppressed = n < 30, design_df = degf(selected)
  )
}
levels <- list(
  insurance = c("Any private coverage", "Public / other, no private", "Uninsured"),
  age = c("18–34", "35–49", "50–64", "65+"),
  education = c("Less than high school", "High school / GED", "Some college / associate", "Bachelor’s or higher"),
  internet = c("Internet access", "No Internet access"),
  health = health_labels,
  insurance_coverage = c("Insured", "Uninsured")
)
overall <- estimate_domain(rep(TRUE, nrow(data)), "All adults")
groups <- lapply(names(levels), function(group) lapply(levels[[group]], function(label) estimate_domain(data[[group]] == label, label)))
names(groups) <- names(levels)
missingness <- lapply(c("telehealth", "insurance", "age", "education", "internet", "health"), function(v) {
  variables <- c(telehealth = "VIRAPP12M_A", insurance = "NOTCOV_A + PRIVATE_A", age = "AGEP_A", education = "EDUCP_A", internet = "ACCSSINT_A", health = "PHSTAT_A")
  list(
    variable = unname(variables[v]), group = v, n = sum(is.na(data[[v]])), percent = mean(is.na(data[[v]])) * 100,
    among_valid_outcome_n = sum(is.na(data[[v]]) & !is.na(data$telehealth))
  )
})
provenance <- jsonlite::fromJSON(file.path(root, ".work", "nhis-provenance.json"))

# Adjusted associations use the same full-sample survey design.
# Complete-case restriction is applied to the design rather than deleting
# records before the design is constructed.
model_design <- subset(design, model_complete)
model_formula <- telehealth ~ insurance_model + age_numeric + education_model + internet_model + health_model
adjusted_fit <- svyglm(model_formula, design = model_design, family = quasibinomial())
stopifnot(isTRUE(adjusted_fit$converged), adjusted_fit$rank == length(coef(adjusted_fit)))
beta <- coef(adjusted_fit)
se_beta <- sqrt(diag(vcov(adjusted_fit)))
stopifnot(all(is.finite(beta)), all(is.finite(se_beta)), all(se_beta > 0), adjusted_fit$df.residual > 0)
critical <- qt(.975, df = adjusted_fit$df.residual)
log_ci <- cbind(beta - critical * se_beta, beta + critical * se_beta)
package_ci <- confint(adjusted_fit, level = .95)
stopifnot(max(abs(log_ci - package_ci)) < 1e-10)
complete_data <- data[data$model_complete, ]
weighted_fit <- glm(model_formula, data = complete_data, family = quasibinomial(), weights = WTFA_A / mean(WTFA_A))
coefficient_difference <- max(abs(coef(weighted_fit) - beta))
stopifnot(isTRUE(weighted_fit$converged), coefficient_difference < 1e-8)
# Args: term is an exact non-intercept coefficient name from the stored model.
# Returns: display label, covariate group, and the explicit reference category.
# Stops on unexpected terms so changed recodes cannot silently mislabel a fit.
term_details <- function(term) {
  if (term == "age_numeric") {
    return(list(label = "Age, per additional year", group = "Age", reference = "One year younger"))
  }
  if (startsWith(term, "insurance_model")) {
    return(list(label = sub("insurance_model", "", term, fixed = TRUE), group = "Insurance", reference = "Any private coverage"))
  }
  if (startsWith(term, "education_model")) {
    return(list(label = sub("education_model", "", term, fixed = TRUE), group = "Education", reference = "Bachelor’s or higher"))
  }
  if (startsWith(term, "internet_model")) {
    return(list(label = sub("internet_model", "", term, fixed = TRUE), group = "Internet access", reference = "Internet access"))
  }
  if (startsWith(term, "health_model")) {
    return(list(label = sub("health_model", "", term, fixed = TRUE), group = "Self-rated health", reference = "Excellent"))
  }
  stop("Unexpected model term: ", term)
}
model_terms <- lapply(names(beta)[names(beta) != "(Intercept)"], function(term) {
  c(list(term = term), term_details(term), list(
    odds_ratio = unname(exp(beta[term])),
    ci_low = unname(exp(log_ci[term, 1])), ci_high = unname(exp(log_ci[term, 2])),
    log_odds_coefficient = unname(beta[term]), standard_error = unname(se_beta[term]),
    p_value = unname(2 * pt(-abs(beta[term] / se_beta[term]), df = adjusted_fit$df.residual))
  ))
})
retained <- rep(TRUE, nrow(data))
exclusion_flow <- lapply(model_variables, function(variable) {
  excluded <- retained & is.na(data[[variable]])
  retained <<- retained & !is.na(data[[variable]])
  list(variable = variable, excluded_at_step = sum(excluded), remaining_n = sum(retained))
})
stopifnot(sum(retained) == sum(data$model_complete))
adjusted_model <- list(
  status = "verified", model = "Survey-weighted logistic regression", link = "logit",
  outcome = "Any video or phone appointment in the past 12 months (VIRAPP12M_A=1)",
  population = "U.S. civilian noninstitutionalized adults aged 18 or older with complete outcome and covariates",
  n = sum(data$model_complete), yes_n = sum(complete_data$telehealth == 1), excluded_n = sum(!data$model_complete),
  formula = "telehealth ~ insurance + age in years + education + Internet access + self-rated health",
  reference_groups = list(insurance = "Any private coverage", education = "Bachelor’s or higher", internet = "Internet access", health = "Excellent"),
  terms = model_terms, exclusion_flow = exclusion_flow,
  quality = list(
    converged = isTRUE(adjusted_fit$converged), rank = adjusted_fit$rank,
    design_df = degf(model_design), residual_df = adjusted_fit$df.residual,
    coefficient_audit_max_difference = coefficient_difference,
    confidence_interval_audit_max_difference = max(abs(log_ci - package_ci))
  ),
  notes = c(
    "Adjusted odds ratios, not risk ratios or probability differences; all listed covariates are included simultaneously.",
    "Survey-weighted quasibinomial logit model with Taylor-linearized covariance; 95% Wald intervals use the model residual survey degrees of freedom.",
    "All missing outcome or covariate values are excluded without imputation. The sequential exclusion counts depend on the listed order and avoid double-counting.",
    "Age is entered linearly in years and top-coded at 85; age nonlinearity, interactions, and alternative insurance definitions have not been assessed.",
    "Past-year telehealth and current insurance have different time windows. These adjusted associations do not establish a causal effect of insurance.",
    "This is an explanatory cross-sectional model. No forecasting, individual prediction, train/test split, or predictive performance claim is included."
  )
)
result <- list(
  source = "National Health Interview Survey", source_short = "NHIS", year = 2024,
  status = "verified_descriptive", population = "U.S. civilian noninstitutionalized adults aged 18 or older",
  measure = "Any appointment by video or phone in the past 12 months", unit = "percent",
  denominator = "Adults with a valid yes/no telehealth response and a valid value for the displayed grouping variable",
  overall = overall, groups = groups, adjusted_model = adjusted_model,
  group_labels = list(insurance = "Insurance", age = "Age", education = "Education", internet = "Internet access", health = "Self-rated health", insurance_coverage = "Insured status"),
  group_notes = list(
    insurance = "Mutually exclusive project hierarchy: NOTCOV_A=1 is uninsured; NOTCOV_A=2 with PRIVATE_A in {1,2} is any private coverage; NOTCOV_A=2 with PRIVATE_A=3 is public or other coverage without private. Unknown recodes are excluded. Private coverage can coexist with Medicare or another plan; these are not exclusive payer types.",
    age = "Age is top-coded at 85. Unknown or blank exact ages are excluded only from age-group estimates; AGE65 is not used to recover unknown exact age.",
    education = "EDUCP_A 0–2: less than high school; 3–4: high school/GED; 5–7: some college/associate; 8–10: bachelor’s or higher. Codes 97/98/99 and blanks are missing.",
    internet = "ACCSSINT_A measures any Internet access, not broadband subscription or connection quality.",
    health = "PHSTAT_A uses the five self-rated health categories; codes 7/8/9 are excluded.",
    insurance_coverage = "NOTCOV_A=1 is uninsured and NOTCOV_A=2 is insured, after NCHS editing."
  ),
  quality = list(
    raw_n = nrow(data), valid_outcome_n = sum(!is.na(data$telehealth)), missing_outcome_n = sum(is.na(data$telehealth)),
    missing_outcome_percent = mean(is.na(data$telehealth)) * 100, missingness = missingness,
    invalid_design_n = 0, strata_n = length(unique(data$PSTRAT)), psu_n = sum(strata_sizes),
    audit = list(
      source_count_matches_codebook = TRUE, yes_count_matches_codebook = TRUE,
      independent_weighted_mean_and_taylor_se = "passed for all displayed estimates", maximum_absolute_difference = max(audit_errors)
    ),
    reliability_rule = "Project screening rule, not a complete implementation of NCHS presentation standards: suppress n<30; flag n<30 or relative standard error>30%. No displayed group triggers this rule."
  ),
  methods = list(
    weighting = "WTFA_A final adult weights; PPSU clusters nested in PSTRAT strata; full survey design created before domain subsetting.",
    variance = "Taylor linearization using R survey; 95% logit-transformed confidence intervals with domain design degrees of freedom.",
    missing = "Outcome codes 7/8/9 and blanks excluded, with no imputation. Each grouping variable uses its own available-case denominator; this is not a complete-case regression sample.",
    adjustment = "The group summaries are unadjusted. A separate adjusted_model reports survey-weighted logistic associations controlling for insurance, age, education, Internet access, and self-rated health. Prediction is not included.",
    interpretation = "Telehealth is self-reported over the past 12 months; insurance is measured at interview. Their time windows do not exactly coincide. Group differences do not establish causation.",
    geography = "National subgroup estimates only; public-use NHIS does not support these state maps.",
    r_version = R.version.string, survey_version = as.character(packageVersion("survey")), jsonlite_version = as.character(packageVersion("jsonlite"))
  ), provenance = provenance
)
dir.create(file.path(root, "data"), showWarnings = FALSE)
jsonlite::write_json(result, file.path(root, "data", "nhis.json"), pretty = TRUE, auto_unbox = TRUE, digits = 10, na = "null")
cat(sprintf("NHIS: n=%d, outcome valid=%d, estimate=%.4f%%, 95%% CI %.4f–%.4f%%; %d independent checks passed.\n", nrow(data), overall$n, overall$estimate, overall$ci_low, overall$ci_high, length(audit_errors)))
cat(sprintf("NHIS adjusted model: complete-case n=%d, excluded=%d, terms=%d, converged=%s, weighted coefficient check max difference=%.3g.\n", adjusted_model$n, adjusted_model$excluded_n, length(model_terms), adjusted_model$quality$converged, coefficient_difference))
