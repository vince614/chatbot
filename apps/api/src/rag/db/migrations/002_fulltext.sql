-- Recherche plein texte : chaque chunk reçoit sa version « normalisée »
-- (mots racinisés, mots vides retirés), calculée avec la configuration 'french'.

-- Colonne générée : Postgres la calcule à partir de content, la remplit pour
-- les chunks déjà en base et la recalcule à chaque INSERT ou UPDATE.
-- L'ingestion n'a rien à changer. 'french' est écrit en dur : une colonne
-- générée exige une expression immuable, donc une configuration explicite.
ALTER TABLE chunks
    ADD COLUMN content_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('french', content)) STORED;

-- Index GIN (index inversé) : pour chaque lexème, la liste des chunks qui le
-- contiennent. C'est lui qui rend l'opérateur @@ rapide sur une grande base.
CREATE INDEX chunks_content_tsv_idx ON chunks USING gin (content_tsv);
