-- Schéma initial du RAG.
-- {{EMBEDDING_DIMENSION}} est remplacé par l'exécuteur de migrations (migrate.ts)
-- avec la valeur de EMBEDDING_DIMENSION : la dimension n'est jamais écrite en dur.

-- Active pgvector dans cette base (fournit le type vector et les opérateurs <=>, <->, <#>).
CREATE EXTENSION IF NOT EXISTS vector;

-- Un document = un fichier PDF ingéré.
CREATE TABLE documents (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Nom du fichier relatif à data/pdfs/ : c'est sa clé métier.
    file_name    text        NOT NULL UNIQUE,
    -- Empreinte du contenu (hex, 64 caractères) : détecte un fichier modifié.
    sha256       char(64)    NOT NULL,
    ingested_at  timestamptz NOT NULL DEFAULT now()
);

-- Un chunk = un morceau de texte d'environ 500 tokens et son vecteur.
CREATE TABLE chunks (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Supprimer un document supprime ses chunks : la réingestion repart de zéro.
    document_id  bigint  NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    -- Position du chunk dans le document (0, 1, 2…).
    chunk_index  integer NOT NULL,
    -- Pages (numérotées à partir de 1) couvertes par le chunk.
    page_start   integer NOT NULL,
    page_end     integer NOT NULL,
    content      text    NOT NULL,
    token_count  integer NOT NULL,
    embedding    vector({{EMBEDDING_DIMENSION}}) NOT NULL,

    UNIQUE (document_id, chunk_index),
    CHECK (page_start >= 1 AND page_end >= page_start),
    CHECK (token_count > 0)
);

-- Pas d'index vectoriel (HNSW / IVFFlat) pour l'instant : voir le cours.
-- La contrainte UNIQUE ci-dessus crée déjà un index B-tree sur document_id,
-- utile pour supprimer rapidement les chunks d'un document.
