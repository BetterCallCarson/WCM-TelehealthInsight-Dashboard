# Predicted probability of past-year telehealth use from the exported
# coefficient tables (HINF 5001, Team 1 prediction models).
#
# data:  one row per respondent. Every variable the model uses must already
#        be coded as in the analysis (see coding_dictionary.csv): age in
#        years; pov_ratio capped at 11; categorical variables as character
#        or factor using the labels in factor_levels.csv.
# model: a model name in model_coefficients.csv, for example
#        "Stepwise BIC logistic".
predict_from_csv <- function(data, model, export_dir = "model_export") {
  read <- function(f) read.csv(file.path(export_dir, f), stringsAsFactors = FALSE)
  coefs <- read("model_coefficients.csv")
  coefs <- coefs[coefs$model == model, ]
  if (nrow(coefs) == 0) stop("Unknown model: ", model)
  factor_levels <- read("factor_levels.csv")
  factor_levels <- factor_levels[order(factor_levels$variable,
                                       factor_levels$level_order), ]
  knots <- read("spline_knots.csv")

  columns <- list()
  for (term in setdiff(unique(coefs$term), "(Intercept)")) {
    if (startsWith(term, "ns(")) {
      v <- sub("^ns\\(([^,]+),.*$", "\\1", term)
      k <- knots[knots$variable == v, ]
      basis <- splines::ns(data[[v]],
                           knots = k$value[k$type == "interior"],
                           Boundary.knots = k$value[k$type == "boundary"])
      for (j in seq_len(ncol(basis))) columns[[paste0(term, j)]] <- basis[, j]
    } else if (term %in% factor_levels$variable) {
      lev <- factor_levels$level[factor_levels$variable == term]
      x <- as.character(data[[term]])
      unknown <- setdiff(unique(x[!is.na(x)]), lev)
      if (length(unknown)) {
        stop("Unknown level(s) of ", term, ": ", paste(unknown, collapse = ", "))
      }
      for (l in lev[-1]) columns[[paste0(term, l)]] <- as.numeric(x == l)
    } else {
      columns[[term]] <- as.numeric(data[[term]])
    }
  }
  x <- do.call(cbind, columns)

  beta <- setNames(coefs$estimate, coefs$column)
  slope <- beta[names(beta) != "(Intercept)"]
  absent <- setdiff(names(slope), colnames(x))
  if (length(absent)) stop("Columns not built: ", paste(absent, collapse = ", "))
  eta <- beta[["(Intercept)"]] + drop(x[, names(slope), drop = FALSE] %*% slope)
  plogis(eta)
}
