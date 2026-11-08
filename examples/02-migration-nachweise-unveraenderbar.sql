-- WAS DIESER AUSSCHNITT ZEIGT
-- Eine Datenbank-Migration (PostgreSQL), die Nachweise unveränderbar macht.
-- * Nachweise dürfen nur angehängt werden. Trigger lehnen UPDATE, DELETE und TRUNCATE ab.
-- * Der Fehler trägt einen festen Constraint-Namen, damit Programm und Tests ihn sicher erkennen.
-- * Check-Constraints prüfen, ob etwas zusammenpasst: genau eine Wert-Spalte passend zum Fragetyp,
--   und eine Abweichung braucht immer einen Maßnahmentext.
-- * Eine Korrektur ist ein neuer Eintrag, der auf das Original zeigt, und zwar höchstens einmal.
--
-- Von Hand geschrieben, weil das ORM (Drizzle) keine Trigger erzeugt. Gekürzt auf das Wesentliche,
-- im Original auf mehrere nummerierte Migrationen verteilt.

-- Tabellen (vereinfacht) ----------------------------------------------------------------------------

CREATE TABLE eintrag (
  id                    uuid PRIMARY KEY,           -- vom iPad erzeugt, doppelte Anfragen zählen einmal
  faelligkeit_id        integer NOT NULL,
  standort_id           integer NOT NULL,
  mitarbeiter_id        integer,
  admin_id              integer,
  server_zeit           timestamptz NOT NULL,       -- bewusst ohne Standardwert, der Dienst setzt sie
  abweichung            boolean NOT NULL,
  massnahme_text        text,                       -- Kopie des Vorlagentexts zum Zeitpunkt der Messung
  nachmessung           boolean NOT NULL DEFAULT false,
  korrigiert_eintrag_id uuid REFERENCES eintrag (id),
  korrektur_grund       text,

  -- Entweder erfasst eine Person am iPad, oder ein Admin korrigiert mit Begründung
  CONSTRAINT eintrag_urheber CHECK (
       (mitarbeiter_id IS NOT NULL AND admin_id IS NULL
        AND korrigiert_eintrag_id IS NULL AND korrektur_grund IS NULL)
    OR (mitarbeiter_id IS NULL AND admin_id IS NOT NULL
        AND korrigiert_eintrag_id IS NOT NULL AND btrim(korrektur_grund) <> '')
  ),
  -- Keine Abweichung ohne Maßnahme
  CONSTRAINT eintrag_abweichung_massnahme CHECK (
    NOT abweichung OR (massnahme_text IS NOT NULL AND btrim(massnahme_text) <> '')
  ),
  -- Jeder Eintrag wird höchstens einmal korrigiert, Korrekturen bilden eine Kette
  CONSTRAINT eintrag_korrigiert_unique UNIQUE (korrigiert_eintrag_id)
);

-- Pro Termin genau ein Ersteintrag. Nachmessungen und Korrekturen kommen dazu.
CREATE UNIQUE INDEX eintrag_erst_eintrag_unique
  ON eintrag (faelligkeit_id)
  WHERE NOT nachmessung AND korrigiert_eintrag_id IS NULL;

CREATE TABLE eintrag_wert (
  eintrag_id    uuid NOT NULL REFERENCES eintrag (id),
  feld_id       integer NOT NULL,
  typ           text NOT NULL,      -- im Original ein Enum
  label         text NOT NULL,      -- Kopie der Frage von damals
  wert_zahl     numeric,
  wert_text     text,
  wert_ok       boolean,
  datei_id      uuid,
  grenzwert_min numeric,            -- Kopie des Grenzwerts, der beim Messen galt
  grenzwert_max numeric,
  PRIMARY KEY (eintrag_id, feld_id),

  -- Genau die Wert-Spalte, die zum Typ passt
  CONSTRAINT eintrag_wert_passt_zum_typ CHECK (
       (typ IN ('temperatur', 'zahl')
        AND wert_zahl IS NOT NULL AND wert_text IS NULL AND wert_ok IS NULL AND datei_id IS NULL)
    OR (typ IN ('text', 'auswahl', 'retouren')
        AND wert_zahl IS NULL AND wert_text IS NOT NULL AND wert_ok IS NULL AND datei_id IS NULL)
    OR (typ IN ('haken', 'ok_nicht_ok')
        AND wert_zahl IS NULL AND wert_text IS NULL AND wert_ok IS NOT NULL AND datei_id IS NULL)
    OR (typ = 'foto'
        AND wert_zahl IS NULL AND wert_text IS NULL AND wert_ok IS NULL AND datei_id IS NOT NULL)
  )
);

-- Nur anhängen ----------------------------------------------------------------------------------------

CREATE FUNCTION nachweis_unveraenderbar() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Nachweise lassen sich nicht ändern oder löschen (% auf %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation', CONSTRAINT = 'nachweis_unveraenderbar';
END;
$$;

CREATE TRIGGER eintrag_unveraenderbar BEFORE UPDATE OR DELETE ON eintrag
  FOR EACH ROW EXECUTE FUNCTION nachweis_unveraenderbar();
CREATE TRIGGER eintrag_nicht_leeren BEFORE TRUNCATE ON eintrag
  FOR EACH STATEMENT EXECUTE FUNCTION nachweis_unveraenderbar();

CREATE TRIGGER eintrag_wert_unveraenderbar BEFORE UPDATE OR DELETE ON eintrag_wert
  FOR EACH ROW EXECUTE FUNCTION nachweis_unveraenderbar();
CREATE TRIGGER eintrag_wert_nicht_leeren BEFORE TRUNCATE ON eintrag_wert
  FOR EACH STATEMENT EXECUTE FUNCTION nachweis_unveraenderbar();

-- Im Original genauso für abzeichnung und audit_log.
-- Bekannte Grenze: Gegen Vollzugriff als Tabellen-Eigentümer hilft ein Trigger nicht. Nächster Schritt ist
-- eine eigene Datenbank-Rolle für die App, die nur lesen und anhängen darf.
