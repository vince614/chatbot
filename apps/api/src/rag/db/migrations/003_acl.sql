-- Droits d'accès : chaque document porte la liste des groupes autorisés à le
-- lire. Un chunk hérite des droits de son document (jointure à la recherche).

-- DEFAULT '{}' (tableau vide) : refus par défaut. Les documents déjà en base
-- deviennent invisibles jusqu'à ce que « npm run ingest » applique l'ACL, et
-- un document inséré sans droits n'est visible par personne.
ALTER TABLE documents
    ADD COLUMN allowed_groups text[] NOT NULL DEFAULT '{}';

-- Index GIN : il accélère l'opérateur de recouvrement && (« au moins un
-- groupe en commun ») utilisé par le filtre de la recherche.
CREATE INDEX documents_allowed_groups_idx ON documents USING gin (allowed_groups);
