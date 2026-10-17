-- Evening safety briefings: structured parts, key numbers, the exact input they were written
-- from (for grounding checks and audit), and which generator wrote them.
ALTER TABLE briefings
    ADD COLUMN go_status    text CHECK (go_status IN ('go', 'caution', 'no_go')),
    ADD COLUMN top_hazard   text,
    ADD COLUMN headline     text,
    ADD COLUMN risks        jsonb,           -- ["Heat index peaks at 97°F around 2 PM", ...]
    ADD COLUMN actions      jsonb,
    ADD COLUMN top_factors  jsonb,
    ADD COLUMN key_numbers  jsonb,           -- BriefingKeyNumbers (shared/types.ts)
    ADD COLUMN unavailable  text[],          -- key_numbers fields with no live data (e.g. no FIRMS key)
    ADD COLUMN inputs       jsonb,           -- the JSON the briefing was written from
    ADD COLUMN generator    text CHECK (generator IN ('gemini', 'template')),
    ADD COLUMN model        text;            -- e.g. 'gemini-3.8-flash'; null for the template
CREATE INDEX briefings_site_created_idx ON briefings (site_id, created_at DESC);
