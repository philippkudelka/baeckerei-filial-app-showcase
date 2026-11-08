/**
 * WAS DIESER AUSSCHNITT ZEIGT
 * Tests (Vitest) zur Fachlogik aus 04-fachlogik.ts:
 * - Tabellen-Tests mit it.each für Grenzfälle (genau auf der Grenze, knapp darüber, beide Richtungen).
 * - Zeit als Eingabe: Jeder Test legt „jetzt“ selbst fest, keine echte Uhr, keine wackeligen Tests.
 * - Erfundene, plausible Beispieldaten für die Retouren-Auswertung.
 *
 * Im Original gibt es dazu Datenbanktests gegen eine echte PostgreSQL (Trigger, Constraints, Transaktionen),
 * Routen-Tests und Browser-Tests mit Playwright.
 */
import { describe, expect, it } from 'vitest'
import {
  ausserhalbGrenzwert,
  berechneStatus,
  gueltigerGrenzwert,
  nachmessStand,
  retourenAuswerten,
  type Messung,
} from './04-fachlogik'

const um = (zeit: string) => new Date(`2026-03-10T${zeit}:00Z`)

describe('ausserhalbGrenzwert', () => {
  const kuehlung = { min: null, max: '7.0' }
  const eiswasser = { min: '-1.0', max: '1.0' }

  it.each([
    ['6.9', kuehlung, false],
    ['7.0', kuehlung, false],
    ['7', kuehlung, false],
    ['7.1', kuehlung, true],
    ['9.0', kuehlung, true],
    ['-1.0', eiswasser, false],
    ['1.0', eiswasser, false],
    ['-1.1', eiswasser, true],
    ['1.1', eiswasser, true],
    ['0.0', { min: null, max: null }, false],
  ])('%s °C bei %j ergibt %s', (wert, grenzwert, erwartet) => {
    expect(ausserhalbGrenzwert(wert, grenzwert)).toBe(erwartet)
  })

  it('nimmt den Grenzwert des Messpunkts, wenn es einen gibt', () => {
    expect(gueltigerGrenzwert({ min: null, max: null }, { minC: '-22.0', maxC: '-18.0' })).toEqual({
      min: '-22.0',
      max: '-18.0',
    })
  })
})

describe('berechneStatus', () => {
  const fenster = { start: um('08:00'), ende: um('10:00') }
  const messung = (zeit: string, abweichung = false): Messung => ({
    zeit: um(zeit),
    nachmessung: false,
    abweichung,
    temperaturAbweichung: abweichung,
  })

  it.each([
    ['07:59', 'geplant'],
    ['08:00', 'offen'],
    ['09:59', 'offen'],
    ['10:00', 'versaeumt'],
  ] as const)('ohne Eintrag um %s: %s', (jetzt, erwartet) => {
    expect(berechneStatus(fenster, [], um(jetzt))).toBe(erwartet)
  })

  it('unterscheidet erledigt, mit Abweichung und nachgetragen', () => {
    expect(berechneStatus(fenster, [messung('08:30')], um('12:00'))).toBe('erledigt')
    expect(berechneStatus(fenster, [messung('08:30', true)], um('12:00'))).toBe(
      'erledigt_mit_abweichung',
    )
    expect(berechneStatus(fenster, [messung('10:15')], um('12:00'))).toBe('nachgetragen')
  })
})

describe('nachmessStand', () => {
  const abweichung: Messung = {
    zeit: um('08:30'),
    nachmessung: false,
    abweichung: true,
    temperaturAbweichung: true,
  }
  const nachmessung = (zeit: string): Messung => ({
    zeit: um(zeit),
    nachmessung: true,
    abweichung: false,
    temperaturAbweichung: false,
  })

  it('läuft 30 Minuten ab der Abweichung', () => {
    expect(nachmessStand([abweichung], um('08:45'))).toEqual({ stand: 'offen', bis: um('09:00') })
  })

  it('ist erledigt, wenn rechtzeitig nachgemessen wurde', () => {
    expect(nachmessStand([abweichung, nachmessung('08:55')], um('12:00'))).toEqual({ stand: 'keine' })
  })

  it('zeigt eine Lücke, auch wenn später noch nachgemessen wurde', () => {
    expect(nachmessStand([abweichung, nachmessung('09:20')], um('12:00'))).toEqual({
      stand: 'luecke',
      bis: um('09:00'),
      nachgeholt: true,
    })
  })
})

describe('retourenAuswerten', () => {
  // Erfundene Beispieldaten
  const nord = {
    standortId: 1,
    standortName: 'Filiale Nord',
    gezaehlt: [
      { nr: '101', name: 'Roggenmischbrot 750 g', geliefert: 12, zurueck: 2 },
      { nr: '205', name: 'Weizenbrötchen', geliefert: 80, zurueck: 6 },
      { nr: '310', name: 'Laugenstange', geliefert: 20, zurueck: 9 },
    ],
  }
  const sued = {
    standortId: 2,
    standortName: 'Filiale Süd',
    gezaehlt: [
      { nr: '101', name: 'Roggenmischbrot 750 g', geliefert: 10, zurueck: 5 },
      { nr: '205', name: 'Weizenbrötchen', geliefert: 60, zurueck: 3 },
      { nr: '310', name: 'Laugenstange', geliefert: 6, zurueck: 4 },
    ],
  }
  const west = { standortId: 3, standortName: 'Filiale West', gezaehlt: null }

  const ergebnis = retourenAuswerten([nord, sued, west])

  it('zählt nur Filialen, die schon gezählt haben', () => {
    expect(ergebnis.gesamt).toBe(3)
    expect(ergebnis.gezaehlt).toBe(2)
    expect(ergebnis.nichtGezaehlt).toEqual([{ id: 3, name: 'Filiale West' }])
  })

  it('summiert pro Artikel über alle Filialen', () => {
    expect(ergebnis.artikel).toEqual([
      { nr: '101', name: 'Roggenmischbrot 750 g', geliefert: 22, zurueck: 7 },
      { nr: '205', name: 'Weizenbrötchen', geliefert: 140, zurueck: 9 },
      { nr: '310', name: 'Laugenstange', geliefert: 26, zurueck: 13 },
    ])
    expect(ergebnis.geliefert).toBe(188)
    expect(ergebnis.zurueck).toBe(29)
  })

  it('meldet „Viel zurück“ erst ab 40 % und mindestens 10 Stück, höchste Quote zuerst', () => {
    // Laugenstange Süd hat 67 %, aber nur 6 geliefert: zu wenig für eine Aussage
    expect(ergebnis.vielZurueck.map((z) => `${z.standortName}: ${z.name}`)).toEqual([
      'Filiale Süd: Roggenmischbrot 750 g', // 50 %
      'Filiale Nord: Laugenstange', // 45 %
    ])
  })
})
