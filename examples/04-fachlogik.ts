/**
 * WAS DIESER AUSSCHNITT ZEIGT
 * Reine Fachregeln ohne Datenbank, ohne Oberfläche und ohne eigene Uhr. Die aktuelle Zeit wird
 * hineingereicht, deshalb sind alle Funktionen deterministisch und einfach zu testen.
 * - Grenzwert: Liegt eine Temperatur außerhalb? Die Grenzen selbst sind erlaubt.
 * - Status: Wird nie gespeichert, sondern aus Zeitfenster, Einträgen und Uhrzeit gerechnet.
 * - Nachmessung: Nach einer Temperatur-Abweichung muss binnen 30 Minuten nachgemessen werden.
 * - Retouren: Auswertung pro Tag über alle Filialen, mit Liste „Viel zurück“.
 *
 * Gekürzt: Im Original löst die Fachlogik zusätzlich Korrektur-Ketten auf (jede Messung zählt in ihrer
 * letzten Fassung). Hier wird vereinfacht angenommen, dass die Einträge schon die gültigen Fassungen sind.
 */

// ---------- Grenzwert ----------

/** Grenzwerte als Text, so wie die Datenbank numeric liefert. null heißt: In diese Richtung keine Grenze. */
export type Grenzwert = { min: string | null; max: string | null }

/**
 * Bei „höchstens 7,0 °C“ sind 7,0 °C in Ordnung und 7,1 °C nicht. Es wird nur verglichen, nicht gerechnet,
 * deshalb entstehen bei Werten mit einer Nachkommastelle keine Rundungsfehler.
 */
export function ausserhalbGrenzwert(wert: string, grenzwert: Grenzwert): boolean {
  const zahl = Number(wert)
  if (grenzwert.min !== null && zahl < Number(grenzwert.min)) return true
  if (grenzwert.max !== null && zahl > Number(grenzwert.max)) return true
  return false
}

/** Ein Messpunkt (z. B. eine Kühltheke) gibt den Grenzwert vor, sonst gilt der eigene der Frage. */
export function gueltigerGrenzwert(
  eigener: Grenzwert,
  messpunkt: { minC: string | null; maxC: string | null } | null,
): Grenzwert {
  return messpunkt ? { min: messpunkt.minC, max: messpunkt.maxC } : eigener
}

// ---------- Status eines Termins ----------

/** Eine gültige Messung, so wie die Fachlogik sie braucht (vereinfacht). */
export type Messung = {
  zeit: Date
  nachmessung: boolean
  abweichung: boolean
  temperaturAbweichung: boolean
}

export type Status =
  | 'geplant'
  | 'offen'
  | 'versaeumt'
  | 'erledigt'
  | 'erledigt_mit_abweichung'
  | 'nachgetragen'

export type Fenster = { start: Date; ende: Date }

/** Der Beginn gehört zum Fenster, das Ende nicht: Um 12:00 Uhr ist ein Fenster bis 12:00 Uhr vorbei. */
export function berechneStatus(fenster: Fenster, messungen: readonly Messung[], jetzt: Date): Status {
  const erst = [...messungen]
    .sort((a, b) => a.zeit.getTime() - b.zeit.getTime())
    .find((m) => !m.nachmessung)
  if (!erst) {
    if (jetzt < fenster.start) return 'geplant'
    return jetzt < fenster.ende ? 'offen' : 'versaeumt'
  }
  if (erst.zeit >= fenster.ende) return 'nachgetragen'
  return erst.abweichung ? 'erledigt_mit_abweichung' : 'erledigt'
}

// ---------- Nachmessung ----------

export const NACHMESS_FRIST_MINUTEN = 30

export type NachmessStand =
  | { stand: 'keine' }
  | { stand: 'offen'; bis: Date }
  /** Frist vorbei. „nachgeholt“: Es gibt eine Messung im Grenzwert, aber erst danach. */
  | { stand: 'luecke'; bis: Date; nachgeholt: boolean }

/**
 * Die Frist läuft ab der letzten Temperatur-Abweichung. Es gibt bewusst keine Sperre: Eine Lücke bleibt
 * sichtbar und wird beim monatlichen Abzeichnen benannt.
 */
export function nachmessStand(messungen: readonly Messung[], jetzt: Date): NachmessStand {
  const sortiert = [...messungen].sort((a, b) => a.zeit.getTime() - b.zeit.getTime())
  const letzte = sortiert.findLast((m) => m.temperaturAbweichung)
  if (!letzte) return { stand: 'keine' }

  const bis = new Date(letzte.zeit.getTime() + NACHMESS_FRIST_MINUTEN * 60_000)
  const imGrenzwert = sortiert.find((m) => m.nachmessung && m.zeit > letzte.zeit)

  if (imGrenzwert) {
    return imGrenzwert.zeit <= bis ? { stand: 'keine' } : { stand: 'luecke', bis, nachgeholt: true }
  }
  return jetzt <= bis ? { stand: 'offen', bis } : { stand: 'luecke', bis, nachgeholt: false }
}

// ---------- Retouren ----------

/** Eine Zeile des Lieferscheins mit der gezählten Rückgabe. */
export type RetourenZeile = { nr: string; name: string; geliefert: number; zurueck: number }

/** Eine Filiale an einem Tag. gezaehlt = null: Die Filiale hat noch nicht gezählt. */
export type FilialRetoure = {
  standortId: number
  standortName: string
  gezaehlt: readonly RetourenZeile[] | null
}

const VIEL_AB_QUOTE = 0.4
const VIEL_AB_MENGE = 10

/** Die Auswertung für die Seite „Retouren“. Es zählen nur Filialen, die schon gezählt haben. */
export function retourenAuswerten(filialen: readonly FilialRetoure[]) {
  const gezaehlt = filialen.flatMap((f) => (f.gezaehlt ? [{ ...f, zeilen: f.gezaehlt }] : []))

  const artikel = new Map<string, { nr: string; name: string; geliefert: number; zurueck: number }>()
  for (const { zeilen } of gezaehlt) {
    for (const z of zeilen) {
      const bisher = artikel.get(z.nr) ?? { nr: z.nr, name: z.name, geliefert: 0, zurueck: 0 }
      artikel.set(z.nr, {
        ...bisher,
        geliefert: bisher.geliefert + z.geliefert,
        zurueck: bisher.zurueck + z.zurueck,
      })
    }
  }
  const liste = [...artikel.values()].sort(
    (a, b) => Number(a.nr) - Number(b.nr) || a.nr.localeCompare(b.nr),
  )

  return {
    gesamt: filialen.length,
    gezaehlt: gezaehlt.length,
    geliefert: liste.reduce((summe, a) => summe + a.geliefert, 0),
    zurueck: liste.reduce((summe, a) => summe + a.zurueck, 0),
    artikel: liste,
    /** Ab 40 % Rückgabe bei mindestens 10 gelieferten Stück, höchste Quote zuerst */
    vielZurueck: gezaehlt
      .flatMap((f) =>
        f.zeilen.map((z) => ({ ...z, standortId: f.standortId, standortName: f.standortName })),
      )
      .filter((z) => z.geliefert >= VIEL_AB_MENGE && z.zurueck / z.geliefert >= VIEL_AB_QUOTE)
      .sort((a, b) => b.zurueck / b.geliefert - a.zurueck / a.geliefert),
    nichtGezaehlt: filialen
      .filter((f) => !f.gezaehlt)
      .map((f) => ({ id: f.standortId, name: f.standortName })),
  }
}
