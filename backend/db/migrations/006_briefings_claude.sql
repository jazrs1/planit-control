-- Briefings can be written by Claude too (writers: Claude, then Gemini, then the template).
ALTER TABLE briefings DROP CONSTRAINT briefings_generator_check;
ALTER TABLE briefings ADD CONSTRAINT briefings_generator_check
    CHECK (generator IN ('claude', 'gemini', 'template'));
