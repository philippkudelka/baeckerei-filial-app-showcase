/**
 * WAS DIESER AUSSCHNITT ZEIGT
 * Fehlerbehandlung im Betrieb, an zwei Stellen:
 * 1. Konfiguration: Umgebungsvariablen werden beim Start mit zod geprüft. In Produktion bricht der Start
 *    ab, wenn Pflichtwerte fehlen. Sicherheitsrelevante Schalter haben keinen stillen Standardwert.
 * 2. Hintergrund-Jobs: Ein Job läuft sofort und danach in festem Abstand. Läufe überholen sich nie,
 *    ein Fehler wird geloggt und beendet nichts, beim Herunterfahren wird der laufende Durchgang abgewartet.
 *
 * Gekürzt und verallgemeinert.
 */
import { z } from 'zod'

// ---------- 1. Konfiguration ----------

/** Leere Variablen aus docker-compose (`FOO=`) gelten als nicht gesetzt. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional())

const istZeitzone = (name: string) => {
  try {
    new Intl.DateTimeFormat('de', { timeZone: name })
    return true
  } catch {
    return false
  }
}

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: optional(z.string()),
  /** Pro Installation eingestellt, steht nicht im Code */
  ZEITZONE: optional(z.string().refine(istZeitzone, 'Unbekannte Zeitzone')),
  /** 32 Byte als Base64, verschlüsselt gespeicherte TOTP-Geheimnisse (AES-256-GCM) */
  GEHEIMNIS_SCHLUESSEL: optional(
    z.string().refine((w) => Buffer.from(w, 'base64').length === 32, 'Muss 32 Byte als Base64 sein'),
  ),
  /** „ja“ verlangt den zweiten Faktor von allen Admins */
  ZWEI_FAKTOR_PFLICHT: optional(z.enum(['ja', 'nein'])),
  APP_URL: optional(z.url()),
})

export type Config = z.infer<typeof Env>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = Env.parse(env) // wirft mit lesbarer Meldung, wenn ein Wert nicht passt
  const produktion = config.NODE_ENV === 'production'

  if (produktion && !config.DATABASE_URL) throw new Error('DATABASE_URL fehlt')
  if (produktion && !config.ZEITZONE) throw new Error('ZEITZONE fehlt')
  // Kein stiller Standard: Wer die Pflicht abschaltet, soll das hingeschrieben haben
  if (produktion && !config.ZWEI_FAKTOR_PFLICHT) {
    throw new Error('ZWEI_FAKTOR_PFLICHT fehlt: ja im Echtbetrieb, nein nur auf einem Testserver')
  }
  // Pflicht ohne Schlüssel hieße: Niemand kann den zweiten Faktor einrichten, niemand kommt mehr rein
  if (produktion && config.ZWEI_FAKTOR_PFLICHT === 'ja' && !config.GEHEIMNIS_SCHLUESSEL) {
    throw new Error('GEHEIMNIS_SCHLUESSEL fehlt, ZWEI_FAKTOR_PFLICHT=ja braucht ihn')
  }
  return config
}

// ---------- 2. Hintergrund-Jobs ----------

/**
 * Führt eine Aufgabe sofort aus und danach immer wieder. Die Pause beginnt erst, wenn der Lauf fertig ist,
 * so überholen sich zwei Läufe nie. Ein Fehler wird gemeldet, der nächste Lauf versucht es wieder.
 */
export function wiederholen(
  aufgabe: () => Promise<void>,
  { abstandMs, beiFehler }: { abstandMs: number; beiFehler: (ursache: unknown) => void },
) {
  let gestoppt = false
  let wecker: ReturnType<typeof setTimeout> | undefined

  const lauf = async () => {
    try {
      await aufgabe()
    } catch (ursache) {
      beiFehler(ursache)
    }
  }
  const danach = () => {
    if (gestoppt) return
    wecker = setTimeout(() => {
      aktuell = lauf().then(danach)
    }, abstandMs)
  }
  const ersterLauf = lauf()
  let aktuell = ersterLauf.then(danach)

  return {
    /** Der erste Lauf ist vorbei, ob er geklappt hat oder nicht */
    ersterLauf,
    /** Wartet einen laufenden Durchgang ab, damit danach niemand mehr die Datenbank braucht */
    stoppen: async () => {
      gestoppt = true
      clearTimeout(wecker)
      await aktuell
    },
  }
}

// ---------- Verwendung beim Serverstart (vereinfacht) ----------

type Logger = { info: (o: object, m: string) => void; error: (o: object, m: string) => void }

/** Ein Teilschritt eines Jobs. Scheitert er, läuft der nächste trotzdem. */
async function schritt(log: Logger, fehlerText: string, arbeit: () => Promise<unknown>) {
  try {
    await arbeit()
  } catch (err) {
    log.error({ err }, fehlerText)
  }
}

export async function jobsStarten(
  log: Logger,
  dienste: {
    termineAnlegen: () => Promise<number>
    ereignissePruefen: () => Promise<void>
    meldungenSenden: () => Promise<void>
  },
) {
  const terminJob = wiederholen(
    async () => {
      const neu = await dienste.termineAnlegen()
      if (neu > 0) log.info({ neu }, 'Termine angelegt')
    },
    { abstandMs: 5 * 60_000, beiFehler: (err) => log.error({ err }, 'Termin-Job fehlgeschlagen') },
  )
  // Der Server öffnet auch, wenn der erste Lauf scheitert. Sonst legt ein Fehler im Job die ganze App lahm.
  await terminJob.ersterLauf

  const meldungJob = wiederholen(
    async () => {
      // Getrennt: Fertige Meldungen sollen auch rausgehen, wenn das Prüfen gerade scheitert
      await schritt(log, 'Ereignisse nicht geprüft', dienste.ereignissePruefen)
      await schritt(log, 'Meldungen nicht verschickt', dienste.meldungenSenden)
    },
    { abstandMs: 30_000, beiFehler: (err) => log.error({ err }, 'Meldungen nicht verschickt') },
  )

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      log.info({ signal }, 'Beende Server')
      await terminJob.stoppen()
      await meldungJob.stoppen()
      // danach: HTTP-Server schließen, Datenbank-Pool beenden
      process.exit(0)
    })
  }
}
