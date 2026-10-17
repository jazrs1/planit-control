-- Crew reports keep the species for wildlife (e.g. 'Snake', 'Alligator'); null otherwise.
ALTER TABLE reports ADD COLUMN species text CHECK (char_length(species) <= 60);
-- Site hazard snapshots read recent reports by time.
CREATE INDEX reports_recent_idx ON reports (created_at DESC, category);
