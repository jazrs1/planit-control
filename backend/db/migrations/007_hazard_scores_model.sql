-- Every scoring run (hourly, after the weather poll) stores the hybrid index for each site's local
-- today and tomorrow in hazard_scores (score, factors), plus the ML weather model's own part, which
-- /sites and the briefing read back between runs (hazards/model_scores.py).
ALTER TABLE hazard_scores
    ADD COLUMN top_hazard        text,
    ADD COLUMN model_probability double precision CHECK (model_probability BETWEEN 0 AND 1),
    ADD COLUMN model_score       double precision CHECK (model_score BETWEEN 0 AND 10),
    ADD COLUMN model_factors     jsonb,          -- the model's own top factors (ml/model.py)
    ADD COLUMN model_version     text;           -- trained_at of ml/models/hazard_model.json
