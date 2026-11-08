/**
 * WAS DIESER AUSSCHNITT ZEIGT
 * Ein API-Endpoint (Fastify) für das Filial-iPad: Eine Messung oder Checkliste wird gespeichert.
 * - Eingabe wird mit einem zod-Schema geprüft, das Oberfläche und Server teilen.
 * - Die Route prüft nur, WER fragt (gekoppeltes Gerät, angemeldete Person). Den Ablauf macht ein Dienst.
 * - Fachliche Fehlercodes des Dienstes werden auf HTTP-Statuscodes abgebildet.
 * - Ein Termin einer fremden Filiale sieht aus wie ein unbekannter Termin (kein Informationsleck).
 * - Die Eintrags-ID erzeugt das Gerät. Eine doppelt gesendete Anfrage liefert 200 statt 201.
 *
 * Gekürzt und verallgemeinert. Importe auf Teile, die hier fehlen, sind als Kommentar markiert.
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

// ---------- Vertrag zwischen iPad und Server (im Original in packages/shared) ----------

const Id = z.number().int().positive().max(2_147_483_647)

/**
 * Temperatur und Zahl kommen als Text wie „7.1“, damit sie exakt bleiben. Haken und ok/nicht ok als ja/nein,
 * Text und Auswahl als Text, ein Foto als die Nummer, die der Server beim Hochladen genannt hat.
 */
const AntwortSenden = z.strictObject({
  feldId: Id,
  // Retouren sind eine ganze Liste, deshalb so viel Platz. Die Fachlogik begrenzt jeden Typ selbst.
  wert: z.union([z.string().max(200_000), z.boolean()]),
})

export const EintragSenden = z.strictObject({
  handlungsToken: z.string().min(1).max(100),
  /** Vom iPad erzeugt, damit eine Wiederholung nur einmal zählt */
  id: z.uuid(),
  faelligkeitId: Id,
  nachmessung: z.boolean().default(false),
  werte: z.array(AntwortSenden).max(100),
  massnahmeVorlageId: Id.nullable().default(null),
  massnahmeFreitext: z.string().max(500).nullable().default(null),
})

// ---------- Abhängigkeiten (im Original eigene Module) ----------

type Fehler = { code: string }
type Ergebnis =
  | { ok: true; eintragId: string; neu: boolean; serverZeit: string; abweichung: boolean }
  | { ok: false; fehler: Fehler[] }

type Abhaengigkeiten = {
  /** Prüft das Bearer-Token des iPads, liefert Gerät und Standort oder null */
  geraetPruefen: (token: string) => Promise<{ id: number; standortId: number } | null>
  /** Prüft das kurzlebige Token der angemeldeten Person */
  handlungPruefen: (
    token: string,
    geraetId: number,
  ) => Promise<{ mitarbeiterId: number; name: string; pinAendern: boolean } | null>
  /** Der Dienst: lädt Termin und Grenzwerte, ruft die Fachlogik, schreibt alles in einer Transaktion */
  eintragSpeichern: (eingabe: Record<string, unknown>) => Promise<Ergebnis>
}

const UNVOLLSTAENDIG = { fehler: 'Die Angaben sind nicht vollständig' }
const NICHT_GEKOPPELT = { fehler: 'Dieses iPad ist nicht gekoppelt oder gesperrt' }
const NICHT_ANGEMELDET = { fehler: 'Bitte melde dich neu an', code: 'nicht_angemeldet' }

/** Fachliche Fehlercodes auf HTTP abbilden. Eine fremde Filiale sieht aus wie ein unbekannter Termin. */
export function statusFuer(codes: readonly string[]): 404 | 409 | 422 {
  if (codes.includes('termin_unbekannt') || codes.includes('falsche_filiale')) return 404
  if (['id_vergeben', 'schon_erledigt', 'zu_alt', 'monat_abgezeichnet'].some((c) => codes.includes(c))) {
    return 409
  }
  return 422
}

function bearerToken(header: string | undefined) {
  return /^Bearer ([\w-]{1,100})$/.exec(header ?? '')?.[1]
}

export const eintragRoute: FastifyPluginAsync<Abhaengigkeiten> = async (
  app,
  { geraetPruefen, handlungPruefen, eintragSpeichern },
) => {
  app.post('/api/geraet/eintraege', async (req, reply) => {
    // 1. Gerät prüfen
    const token = bearerToken(req.headers.authorization)
    const geraet = token ? await geraetPruefen(token) : null
    if (!geraet) return reply.code(401).send(NICHT_GEKOPPELT)

    // 2. Eingabe prüfen
    const eingabe = EintragSenden.safeParse(req.body)
    if (!eingabe.success) return reply.code(400).send(UNVOLLSTAENDIG)
    const { handlungsToken, faelligkeitId, werte, ...rest } = eingabe.data

    // 3. Person prüfen
    const handlung = await handlungPruefen(handlungsToken, geraet.id)
    if (!handlung) return reply.code(401).send(NICHT_ANGEMELDET)
    if (handlung.pinAendern) {
      return reply.code(403).send({ fehler: 'Bitte lege zuerst deine eigene PIN fest', code: 'pin_aendern' })
    }

    // 4. Ablauf an den Dienst übergeben. Standort kommt vom Gerät, nie aus der Anfrage.
    const ergebnis = await eintragSpeichern({
      ...rest,
      terminId: faelligkeitId,
      antworten: werte,
      mitarbeiterId: handlung.mitarbeiterId,
      geraetId: geraet.id,
      standortId: geraet.standortId,
    })

    if (!ergebnis.ok) {
      const codes = ergebnis.fehler.map((f) => f.code)
      // Gerät wurde gesperrt, während die Anfrage lief: Antwort wie bei jeder Anfrage danach
      if (codes.includes('geraet_gesperrt')) return reply.code(401).send(NICHT_GEKOPPELT)
      const status = statusFuer(codes)
      return reply.code(status).send({
        fehler: 'Der Eintrag wurde nicht gespeichert',
        // Bei 404 keine Details, damit niemand fremde Termine abtasten kann
        details: status === 404 ? [{ code: 'termin_unbekannt' }] : ergebnis.fehler,
      })
    }

    // 5. Neu angelegt: 201. Dieselbe ID kam schon einmal an: 200 mit demselben Ergebnis.
    return reply.code(ergebnis.neu ? 201 : 200).send({
      eintragId: ergebnis.eintragId,
      neu: ergebnis.neu,
      serverZeit: ergebnis.serverZeit,
      abweichung: ergebnis.abweichung,
      name: handlung.name,
    })
  })
}
