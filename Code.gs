/**
 * Getränke abrechnen – Speicher und Mailversand für die App
 * Sportverein Blau-Weiß Etteln 1923 e.V.
 *
 * Was dieses Skript macht:
 *  - speichert Artikel, Abteilungen, Personen und alle Einträge in der Google-Tabelle „Getränke-Abrechnung“
 *  - prüft bei jeder Anfrage, wer anfragt und was diese Person darf
 *  - verschickt die Abrechnungen als PDF über dein Gmail-Konto, aber nur wenn in der App jemand auf „Senden“ tippt
 *
 * Einrichtung (siehe ANLEITUNG): als Web-App bereitstellen, dann die Funktion „einrichten“ ausführen.
 */

/* ---------- Einmal ausführen ---------- */
function einrichten() {
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('KEY')) p.setProperty('KEY', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  var ss = mappe_();
  blatt_(ss, 'Einträge'); ladeCfg_();
  /* legt den Ordner für die PDFs an und löst dabei die einmalige Frage nach dem Zugriff auf Google Drive aus */
  var ordner = belegOrdner_(Utilities.formatDate(new Date(), 'Europe/Berlin', 'yyyy-MM'));
  var rest = MailApp.getRemainingDailyQuota();
  var url = ScriptApp.getService().getUrl();
  Logger.log('Tabelle: ' + ss.getUrl());
  Logger.log('Heute noch möglich: ' + rest + ' E-Mails.');
  Logger.log('PDFs aller Abrechnungen liegen in Google Drive im Ordner „Getränke-Abrechnung – Belege“: ' + ordner.getUrl());
  if (url) {
    Logger.log('Diesen Link fügst du in der App ein (das ist dein Admin-Link, nicht weitergeben):');
    Logger.log(url + '?k=' + p.getProperty('KEY'));
  } else {
    Logger.log('Noch keine Web-App bereitgestellt: erst „Bereitstellen → Neue Bereitstellung → Web-App“, dann „einrichten“ noch einmal ausführen.');
  }
}

/* Falls dein Admin-Link in falsche Hände geraten ist: ausführen, danach gilt nur noch der neue Link. */
function neuerAdminLink() {
  var p = PropertiesService.getScriptProperties();
  p.setProperty('KEY', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  Logger.log(ScriptApp.getService().getUrl() + '?k=' + p.getProperty('KEY'));
}

/* Passwort für das Zahnrad vergessen: ausführen, danach legst du in der App ein neues fest. */
function passwortLoeschen() {
  var cfg = ladeCfg_();
  delete cfg.set.pw;
  speichereCfg_(cfg);
  Logger.log('Das Passwort ist gelöscht. Tippe in der App auf das Zahnrad und lege ein neues fest.');
}

/* ---------- Schnittstelle für die App ---------- */
function doGet(e) {
  return json_({ ok: true, name: 'Getränke abrechnen', hinweis: 'Diese Adresse gehört in die App.' });
}

function doPost(e) {
  var req = {};
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'Ungültige Anfrage' }); }
  /* Nur Schreiben wartet aufeinander. Lesen geht parallel und kommt meist direkt aus dem Zwischenspeicher. */
  var schreibt = req.a && req.a !== 'init' && req.a !== 'load' && req.a !== 'pw' && req.a !== 'archiv' && req.a !== 'archivEins';
  try {
    return json_(schreibt ? gesperrt_(function () { return Core.handle(req, io_()); }) : Core.handle(req, io_()));
  } catch (err) {
    if (err && err.besetzt) return json_({ ok: false, error: 'Gerade ist viel los. Bitte gleich noch einmal versuchen.' });
    return json_({ ok: false, error: 'Fehler im Skript: ' + (err && err.message ? err.message : err) });
  }
}

/* Schreiben (und das Neubefüllen des Zwischenspeichers) passiert nacheinander, damit nie ein alter Stand gemerkt wird. */
var GESPERRT_ = false;
function gesperrt_(fn) {
  if (GESPERRT_) return fn();
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (err) { var x = new Error('besetzt'); x.besetzt = true; throw x; }
  GESPERRT_ = true;
  try { return fn(); } finally { GESPERRT_ = false; lock.releaseLock(); }
}

function json_(o) { if (!o.app) { o.app = Core.APP; o.v = Core.VERSION; } return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* ---------- Speicher: Google-Tabelle, mit Zwischenspeicher für schnelle Antworten ---------- */
var ARCHIV_SPALTEN = ['ID', 'Gesendet am', 'Art', 'Name', 'Zeitraum', 'Summe (€)', 'An', 'Von', 'Wie', 'Datei in Drive', 'Link', 'Daten (nicht ändern)', 'Beleg 1', 'Beleg 2', 'Beleg 3', 'Beleg 4', 'Beleg 5', 'Beleg 6'];
var SPALTEN = ['ID', 'Zeitraum', 'Abteilung', 'Person', 'Inhalt', 'Eingetragen von', 'Eingetragen am', 'Daten'];
var MAPPE_ = null, BLATT_ = {}, CACHE_ZEIT = 21600;
function cache_() { return CacheService.getScriptCache(); }
/* Große Texte werden in Stücke geteilt. Jede Fassung bekommt eine eigene Marke, damit nie Stücke zweier Fassungen gemischt werden. */
function merke_(key, text) {
  var c = cache_(), n = Math.max(1, Math.ceil(text.length / 30000)), marke = Utilities.getUuid().slice(0, 8), teile = {};
  if (n > 40) { c.remove(key); return; }
  for (var i = 0; i < n; i++) teile[key + '#' + marke + '#' + i] = text.slice(i * 30000, (i + 1) * 30000);
  try { c.putAll(teile, CACHE_ZEIT); c.put(key, marke + ':' + n, CACHE_ZEIT); } catch (e) { try { c.remove(key); } catch (e2) {} }
}
function hole_(keys) {
  var c = cache_(), out = {}, kopf = {}, teilKeys = [];
  try { kopf = c.getAll(keys) || {}; } catch (e) { return out; }
  keys.forEach(function (k) { var h = /^(\w+):(\d+)$/.exec(kopf[k] || ''); if (!h) return; for (var i = 0; i < +h[2]; i++) teilKeys.push(k + '#' + h[1] + '#' + i); });
  if (!teilKeys.length) return out;
  var teile = {}; try { teile = c.getAll(teilKeys) || {}; } catch (e) { return out; }
  keys.forEach(function (k) {
    var h = /^(\w+):(\d+)$/.exec(kopf[k] || ''); if (!h) return;
    var t = []; for (var i = 0; i < +h[2]; i++) { var x = teile[k + '#' + h[1] + '#' + i]; if (typeof x !== 'string') return; t.push(x); }
    out[k] = t.join('');
  });
  return out;
}
function vergiss_(keys) { try { cache_().removeAll(keys); } catch (e) {} }

function mappe_() {
  if (MAPPE_) return MAPPE_;
  var p = PropertiesService.getScriptProperties(), id = p.getProperty('SHEET'), ss = null;
  if (id) {
    /* Tabelle gibt es schon: kurz hakt Google manchmal – dann nochmal versuchen, aber nie eine neue anlegen */
    for (var v = 0; !ss && v < 3; v++) { if (v) Utilities.sleep(500); try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
    if (!ss) throw new Error('Die Tabelle „Getränke-Abrechnung“ ist gerade nicht erreichbar. Bitte gleich noch einmal versuchen.');
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Getränke-Abrechnung');
    p.setProperty('SHEET', ss.getId());
    var erstes = ss.getSheets()[0];
    erstes.setName('Einträge');
    erstes.appendRow(SPALTEN);
    erstes.setFrozenRows(1);
  }
  MAPPE_ = ss;
  return ss;
}

function blatt_(ss, name) {
  if (BLATT_[name]) return BLATT_[name];
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (name === 'Einträge') { sh.appendRow(SPALTEN); sh.setFrozenRows(1); }
    if (name === 'Archiv') { sh.appendRow(ARCHIV_SPALTEN); sh.setFrozenRows(1); }
    if (name === 'Versand') { sh.appendRow(['Gesendet am', 'An', 'Kopie', 'Betreff', 'Datei']); sh.setFrozenRows(1); }
  }
  BLATT_[name] = sh;
  return sh;
}

/* Ordner „Getränke-Abrechnung – Belege“ in Google Drive, darin je ein Unterordner pro Monat */
function belegOrdner_(monat) {
  var p = PropertiesService.getScriptProperties(), id = p.getProperty('BELEGE'), wurzel = null;
  if (id) { try { wurzel = DriveApp.getFolderById(id); } catch (e) { wurzel = null; } }
  if (!wurzel) { wurzel = DriveApp.createFolder('Getränke-Abrechnung – Belege'); p.setProperty('BELEGE', wurzel.getId()); }
  var name = /^\d{4}-\d{2}$/.test(String(monat)) ? String(monat) : 'Sonstige', it = wurzel.getFoldersByName(name);
  return it.hasNext() ? it.next() : wurzel.createFolder(name);
}

/* Stammdaten liegen als Text im Blatt „Stammdaten“ (bitte dort nichts von Hand ändern). */
function ladeCfg_() {
  var roh = hole_(['cfg']).cfg, cfg = null;
  if (roh) { try { cfg = JSON.parse(roh); } catch (e) { cfg = null; } }
  if (!cfg && !GESPERRT_) return gesperrt_(ladeCfg_);
  for (var versuch = 0; !cfg && versuch < 4; versuch++) {
    if (versuch) Utilities.sleep(400);
    var sh = blatt_(mappe_(), 'Stammdaten'), n = sh.getLastRow();
    if (n > 0) {
      var teile = sh.getRange(1, 1, n, 1).getValues().map(function (r) { return String(r[0]).replace(/^J:/, ''); });
      try { cfg = JSON.parse(teile.join('')); merke_('cfg', teile.join('')); } catch (e) { cfg = null; }
    }
    if (!cfg && !PropertiesService.getScriptProperties().getProperty('CFG')) break;
  }
  if (!cfg || !cfg.arts || !cfg.depts) {
    /* Nur beim allerersten Mal mit der Standardliste anfangen. Sind schon Stammdaten gespeichert worden, wird nie stillschweigend zurückgesetzt. */
    if (PropertiesService.getScriptProperties().getProperty('CFG')) throw new Error('Die Stammdaten sind gerade nicht lesbar. Bitte noch einmal versuchen. Bleibt es dabei: Blatt „Stammdaten“ in der Tabelle prüfen.');
    cfg = Core.standard(); speichereCfg_(cfg);
  }
  cfg.pers = cfg.pers || []; cfg.set = cfg.set || {}; cfg.sent = cfg.sent || {};
  return cfg;
}

function speichereCfg_(cfg) {
  var sh = blatt_(mappe_(), 'Stammdaten'), text = JSON.stringify(cfg), teile = [];
  for (var i = 0; i < text.length; i += 40000) teile.push(['J:' + text.slice(i, i + 40000)]);
  sh.clearContents();
  sh.getRange(1, 1, teile.length, 1).setValues(teile);
  SpreadsheetApp.flush();
  merke_('cfg', text);
  PropertiesService.getScriptProperties().setProperty('CFG', '1');
}

/* Nur im Notfall: Stammdaten (Artikel, Abteilungen, Personen, Passwort) auf den Anfang zurücksetzen. Die Einträge bleiben. */
function stammdatenZuruecksetzen() {
  speichereCfg_(Core.standard());
  Logger.log('Die Stammdaten sind zurückgesetzt.');
}

/* Nach Änderungen von Hand in der Tabelle: Zwischenspeicher leeren, damit die App alles neu liest. */
function zwischenspeicherLeeren() {
  vergiss_(['cfg']);
  var monate = []; for (var j = 0; j < 36; j++) { var d = new Date(); d.setMonth(d.getMonth() - j); monate.push('ent:' + Utilities.formatDate(d, 'Europe/Berlin', 'yyyy-MM')); }
  vergiss_(monate);
  Logger.log('Zwischenspeicher geleert.');
}

function lesbar_(e) {
  return (e.it || []).map(function (it) {
    var t = [];
    if (it.k) t.push(it.k + ' Ki.');
    if (it.f) t.push(it.f + (it.ks ? ' Fl.' : ' ×'));
    return t.join(' + ') + ' ' + it.n;
  }).join('; ') + (e.v ? ' – Vermerk: ' + e.v : '') + (e.x ? ' – STORNIERT' + (e.x.grund ? ': ' + e.x.grund : '') : '');
}

/* Texte, die mit = + - @ beginnen, würde die Tabelle als Formel lesen */
function zelle_(t) { t = String(t == null ? '' : t); return /^[=+\-@]/.test(t) ? "'" + t : t; }

/* Zeile im Blatt „Archiv“ zu einer ID (Spalte A), sonst 0 */
function archivZeile_(id) {
  var sh = blatt_(mappe_(), 'Archiv'), n = sh.getLastRow(); if (n < 2) return 0;
  var ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === '#' + id) return i + 2;
  return 0;
}

function io_() {
  var p = PropertiesService.getScriptProperties(), cfg = null;
  function blattE() { return blatt_(mappe_(), 'Einträge'); }
  /* liest nur die Spalte mit den Daten, Zeile für Zeile als Eintrag */
  function alleZeilen() {
    var sh = blattE(), n = sh.getLastRow(), out = [];
    if (n < 2) return out;
    sh.getRange(2, SPALTEN.length, n - 1, 1).getValues().forEach(function (r, i) {
      var e = null; try { e = JSON.parse(String(r[0])); } catch (err) { e = null; }
      if (e && e.z) out.push({ zeile: i + 2, e: e });
    });
    return out;
  }
  function monatVon(e) { return e.z.slice(0, 7); }
  function cacheMonat(m, liste) { merke_('ent:' + m, JSON.stringify(liste)); }
  return {
    adminKey: p.getProperty('KEY'),
    cfg: function () { cfg = ladeCfg_(); return cfg; },
    saveCfg: function (x) { speichereCfg_(x); },
    entries: function (monate) {
      if (monate) {
        var treffer = hole_(monate.map(function (m) { return 'ent:' + m; })), out = [], fehlt = [];
        monate.forEach(function (m) { var roh = treffer['ent:' + m]; if (roh) { try { out = out.concat(JSON.parse(roh)); return; } catch (err) {} } fehlt.push(m); });
        if (!fehlt.length) return out;
        if (!GESPERRT_) return gesperrt_(function () { return io_().entries(monate); });
        var neu = {}; fehlt.forEach(function (m) { neu[m] = []; });
        alleZeilen().forEach(function (z) { var m = monatVon(z.e); if (neu[m]) neu[m].push(z.e); });
        fehlt.forEach(function (m) { cacheMonat(m, neu[m]); out = out.concat(neu[m]); });
        return out;
      }
      return alleZeilen().map(function (z) { return z.e; });
    },
    add: function (e) {
      blattE().appendRow(['#' + e.id, e.z, e.dn || e.d, e.pn || '', lesbar_(e), e.by, new Date(e.at), JSON.stringify(e)]);
      var m = monatVon(e), roh = hole_(['ent:' + m])['ent:' + m];
      if (roh) { try { var liste = JSON.parse(roh); liste.push(e); cacheMonat(m, liste); } catch (err) { vergiss_(['ent:' + m]); } }
    },
    /* Einträge als storniert markieren (x gesetzt) oder wieder zurückholen (x = null) */
    markiere: function (ids, x) {
      var sh = blattE(), z = alleZeilen(), monate = {};
      z.forEach(function (r) {
        if (ids.indexOf(r.e.id) < 0) return;
        if (x) r.e.x = x; else delete r.e.x;
        sh.getRange(r.zeile, 5, 1, 1).setValues([[lesbar_(r.e)]]); sh.getRange(r.zeile, SPALTEN.length, 1, 1).setValues([[JSON.stringify(r.e)]]);
        monate[monatVon(r.e)] = 1;
      });
      Object.keys(monate).forEach(function (m) { vergiss_(['ent:' + m]); });
    },
    /* Lose PDFs im Hauptordner in Unterordner je Monat verschieben (nach Archiv, sonst nach Jahr-Monat im Dateinamen) */
    sortiereBelege: function (zuordnung) {
      var id = p.getProperty('BELEGE'); if (!id) return 0;
      var wurzel = DriveApp.getFolderById(id), it = wurzel.getFiles(), n = 0;
      while (it.hasNext()) {
        var f = it.next(), m = zuordnung[f.getId()];
        if (!m) { var t = /(\d{4})-(\d{2})/.exec(f.getName()); if (t) m = t[1] + '-' + t[2]; }
        if (m) { f.moveTo(belegOrdner_(m)); n++; }
      }
      return n;
    },
    ersetze: function (id, e) { this.del([id]); this.add(e); },
    del: function (ids) {
      var sh = blattE(), z = alleZeilen(), monate = {};
      for (var i = z.length - 1; i >= 0; i--) if (ids.indexOf(z[i].e.id) >= 0) { sh.deleteRow(z[i].zeile); monate[monatVon(z[i].e)] = 1; }
      Object.keys(monate).forEach(function (m) {
        var roh = hole_(['ent:' + m])['ent:' + m]; if (!roh) return;
        try { cacheMonat(m, JSON.parse(roh).filter(function (e) { return ids.indexOf(e.id) < 0; })); } catch (err) { vergiss_(['ent:' + m]); }
      });
    },
    mail: function (o) {
      var blob = o.fid ? DriveApp.getFileById(o.fid).getBlob().setName(o.datei) : Utilities.newBlob(Utilities.base64Decode(o.pdf), 'application/pdf', o.datei);
      var opt = { attachments: [blob], name: 'SV Etteln Getränke' };
      if (o.kopie && o.kopie.length) opt.cc = o.kopie.join(',');
      MailApp.sendEmail(o.an.join(','), o.betreff, o.text, opt);
      /* Die letzte Spalte „A“ heißt: steht auch im Archiv. Ältere Zeilen ohne „A“ zeigt die App als „früher verschickt“. */
      blatt_(mappe_(), 'Versand').appendRow([new Date(), o.an.join(', '), (o.kopie || []).join(', '), o.betreff, o.datei, 'A']);
    },
    /* Kurze Hinweis-Mail ohne Anhang (z. B. „Freie Abrechnung wartet auf Freigabe“) */
    hinweisMail: function (o) {
      MailApp.sendEmail(o.an.join(','), o.betreff, o.text, { name: 'SV Etteln Getränke' });
    },
    /* PDF als Datei in Google Drive ablegen */
    ablegen: function (o) {
      var blob = Utilities.newBlob(Utilities.base64Decode(o.pdf), 'application/pdf', o.datei);
      var f = belegOrdner_(o.ordner).createFile(blob);
      return { fid: f.getId(), url: f.getUrl() };
    },
    /* Archiv: Spalte 12 = Kopfdaten als Text, Spalten 13 bis 18 = der eingefrorene Beleg in Stücken */
    archivAdd: function (r) {
      var leicht = {}, beleg = r.beleg ? JSON.stringify(r.beleg) : '';
      for (var k in r) if (k !== 'beleg') leicht[k] = r[k];
      if (beleg.length > 6 * 40000) { beleg = ''; leicht.zuGross = true; }
      var zeile = ['#' + r.id, new Date(r.at), r.art === 'frei' ? 'Freie Abrechnung' : 'Abteilung', zelle_(r.name), r.zeit, Math.round((r.summe || 0)) / 100, zelle_((r.an || []).join(', ')), zelle_(r.by), r.wie === 'export' ? 'exportiert' : 'gesendet', r.fid || '', r.url || '', JSON.stringify(leicht)];
      for (var i = 0; i < beleg.length; i += 40000) zeile.push(beleg.slice(i, i + 40000));
      blatt_(mappe_(), 'Archiv').appendRow(zeile);
    },
    archivListe: function () {
      var sh = blatt_(mappe_(), 'Archiv'), n = sh.getLastRow(), out = [];
      if (n < 2) return out;
      sh.getRange(2, 12, n - 1, 2).getValues().forEach(function (z) {
        var r = null; try { r = JSON.parse(String(z[0])); } catch (err) { r = null; }
        if (r && r.id) { r.beleg = (String(z[1]) && !r.zuGross) ? 1 : 0; out.push(r); }
      });
      out.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
      return out.slice(0, 600);
    },
    archivHol: function (id) {
      var z = archivZeile_(id); if (!z) return null;
      var vals = blatt_(mappe_(), 'Archiv').getRange(z, 12, 1, 7).getValues()[0], r = null;
      try { r = JSON.parse(String(vals[0])); } catch (err) { return null; }
      var teile = vals.slice(1).map(String).join('');
      if (teile) { try { r.beleg = JSON.parse(teile); } catch (err2) { r.beleg = null; } }
      return r;
    },
    archivSetze: function (r) {
      var z = archivZeile_(r.id); if (!z) return;
      var leicht = {}; for (var k in r) if (k !== 'beleg') leicht[k] = r[k];
      blatt_(mappe_(), 'Archiv').getRange(z, 12, 1, 1).setValues([[JSON.stringify(leicht)]]);
    },
    /* Mails, die vor dem Archiv verschickt wurden: nur Datum, Empfänger, Betreff */
    altVersand: function () {
      var sh = blatt_(mappe_(), 'Versand'), n = sh.getLastRow(), out = [];
      if (n < 2) return out;
      sh.getRange(2, 1, n - 1, 6).getValues().forEach(function (z) {
        if (String(z[5]) === 'A') return;
        var d = z[0] instanceof Date ? z[0] : new Date(z[0]); if (isNaN(d)) return;
        out.push({ at: d.toISOString(), an: String(z[1]), betreff: String(z[3]), datei: String(z[4]) });
      });
      out.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
      return out.slice(0, 300);
    },
    now: function () { return new Date().toISOString(); },
    id: function () { return Utilities.getUuid().replace(/-/g, '').slice(0, 16); }
  };
}

/* ===== Kern: Regeln und Rechnen (gleich in App und Google-Skript) ===== */
var Core = (function () {
  'use strict';

  function standard() {
    function art(id, name, sorten, preis, kiste) { return { id: id, name: name, sorten: sorten, preis: preis, kiste: kiste, rt: 'pct', rv: 10, aktiv: true }; }
    function abt(id, name, modus, rabatt) { return { id: id, name: name, modus: modus, rabatt: rabatt, mails: [], leute: [], aktiv: true }; }
    return {
      v: 1,
      arts: [
        art('bier', 'Bier 0,33 l', 'Warsteiner, Warsteiner 0,0, Pilger, Blue, Radler, Radler 0,0', 1.40, 24),
        art('weizen', 'Weizen 0,5 l', 'Weizen, Weizen alkoholfrei', 1.90, 20),
        art('soft', 'Softdrinks 0,33 l', 'Cola, Cola zero, Fanta, Sprite', 1.10, 24),
        art('wasser', 'Wasser/Schorle 0,25 l', 'Wasser, Apfelschorle, Sportaktiv', 0.85, 24)
      ],
      depts: [
        abt('m1', '1. Mannschaft', 'person', false),
        abt('m2', '2. Mannschaft', 'tag', true),
        abt('ah', 'Alte Herren', 'tag', true),
        abt('darts', 'Darts', 'tag', true),
        abt('vorstand', 'Vorstand', 'tag', true)
      ],
      pers: [],
      set: { admin: 'Admin', hinweis: '', kopie: [], tage: true },
      sent: {}
    };
  }

  /* ---------- kleine Helfer ---------- */
  function str(x, max) { return String(x == null ? '' : x).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max || 80); }
  function zahl(x, min, max) { var n = Number(String(x).replace(',', '.')); if (!isFinite(n)) n = 0; return Math.min(max, Math.max(min, n)); }
  function ganz(x, max) { return Math.round(zahl(x, 0, max || 9999)); }
  function cent(euro) { return Math.round(Number(euro) * 100); }
  function istTag(z) { return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(z); }
  function istMonat(z) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(z); }
  function mailsVon(x) {
    var list = Array.isArray(x) ? x : String(x || '').split(/[\s,;]+/), out = [];
    list.forEach(function (m) { m = str(m, 120).toLowerCase(); if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m) && out.indexOf(m) < 0) out.push(m); });
    return out.slice(0, 10);
  }
  function finde(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function neueId(list, name, io) {
    var b = str(name, 40).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 18) || 'x';
    var id = b, n = 2; while (finde(list, id)) id = b + '-' + n++;
    return id;
  }

  /* ---------- SHA-256 für das Passwort (läuft gleich in App und Google-Skript) ---------- */
  var SHA_H = [], SHA_K = [];
  (function () {
    var zusammen = {}, n = 0;
    for (var c = 2; n < 64; c++) {
      if (zusammen[c]) continue;
      for (var i = 0; i < 313; i += c) zusammen[i] = c;
      SHA_H[n] = (Math.pow(c, 0.5) * 4294967296) | 0;
      SHA_K[n++] = (Math.pow(c, 1 / 3) * 4294967296) | 0;
    }
  })();
  function sha256(text) {
    function rot(v, a) { return (v >>> a) | (v << (32 - a)); }
    var bytes = unescape(encodeURIComponent(String(text))), bits = bytes.length * 8, words = [], hash = SHA_H.slice(0, 8), i, j, out = '';
    bytes += '\x80';
    while (bytes.length % 64 - 56) bytes += '\x00';
    for (i = 0; i < bytes.length; i++) words[i >> 2] |= bytes.charCodeAt(i) << ((3 - i) % 4) * 8;
    words[words.length] = (bits / 4294967296) | 0;
    words[words.length] = bits | 0;
    for (j = 0; j < words.length;) {
      var w = words.slice(j, j += 16), alt = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2], a = hash[0], e = hash[4];
        var t1 = hash[7] + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & hash[5]) ^ ((~e) & hash[6])) + SHA_K[i] +
          (w[i] = (i < 16) ? (w[i] | 0) : (w[i - 16] + (rot(w15, 7) ^ rot(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rot(w2, 17) ^ rot(w2, 19) ^ (w2 >>> 10))) | 0);
        var t2 = (rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(t1 + t2) | 0].concat(hash); hash[4] = (hash[4] + t1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + alt[i]) | 0;
    }
    for (i = 0; i < 8; i++) for (j = 3; j + 1; j--) { var b = (hash[i] >> (j * 8)) & 255; out += (b < 16 ? '0' : '') + b.toString(16); }
    return out;
  }
  function pwGesetzt(cfg) { return !!(cfg.set && cfg.set.pw && cfg.set.pw.h); }
  function pwStimmt(cfg, pw) { return pwGesetzt(cfg) && sha256(cfg.set.pw.s + String(pw == null ? '' : pw)) === cfg.set.pw.h; }

  /* ---------- Rechte ---------- */
  function darfEin(me, deptId) { var e = me.r.ein; return me.r.admin || e === true || (Array.isArray(e) && e.indexOf(deptId) >= 0); }
  function darfIrgendEin(me) { var e = me.r.ein; return me.r.admin || e === true || (Array.isArray(e) && e.length > 0); }
  function rechte(r) {
    r = r || {};
    var ein = r.ein === true ? true : (Array.isArray(r.ein) ? r.ein.map(function (x) { return str(x, 40); }) : []);
    return { ein: ein, abr: !!r.abr, verw: !!r.verw, admin: !!r.admin, frei: !!r.frei };
  }
  function erstesWort(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
  function werBin(cfg, key, adminKey) {
    if (!key) return null;
    if (adminKey && key === adminKey) return { id: 'admin', name: cfg.set.admin || 'Admin', hallo: erstesWort(cfg.set.admin || ''), r: { ein: true, abr: true, verw: true, admin: true, frei: true }, haupt: true };
    for (var i = 0; i < cfg.pers.length; i++) {
      var p = cfg.pers[i];
      if (p.tok === key && !p.gesperrt) { var r = rechte(p.r); if (r.admin) { r.ein = true; r.abr = true; r.verw = true; r.frei = true; } return { id: p.id, name: p.name, hallo: p.hallo || erstesWort(p.name), r: r }; }
    }
    return null;
  }
  /* Namenslisten alphabetisch nach Nachname (letztes Wort), bei gleichem Nachnamen nach dem ganzen Namen */
  function nachname(n) { var w = String(n || '').trim().split(/\s+/); return (w[w.length - 1] || '').toLowerCase(); }
  function nachSort(list) {
    return (list || []).slice().sort(function (a, b) {
      var c = nachname(a.name).localeCompare(nachname(b.name), 'de'); if (c) return c;
      return String(a.name || '').localeCompare(String(b.name || ''), 'de');
    });
  }
  /* Was eine Person von den Stammdaten sehen darf */
  function sicht(cfg, me) {
    var voll = me.r.admin || me.r.verw || me.r.abr;
    var out = { v: cfg.v, arts: cfg.arts, sent: voll ? cfg.sent : {}, set: { hinweis: cfg.set.hinweis, tage: cfg.set.tage !== false, pw: pwGesetzt(cfg) } };
    /* wer das Zahnrad öffnen darf, bekommt Salz und Prüfsumme, damit die App das Passwort ohne Wartezeit selbst prüft */
    if (voll && pwGesetzt(cfg)) { out.set.pwS = cfg.set.pw.s; out.set.pwH = cfg.set.pw.h; }
    out.depts = cfg.depts.filter(function (d) { return voll || darfEin(me, d.id); }).map(function (d) {
      return { id: d.id, name: d.name, modus: d.modus, rabatt: !!d.rabatt, aktiv: d.aktiv !== false, leute: nachSort(d.leute), mails: voll ? (d.mails || []) : [] };
    });
    if (me.r.admin) { out.storno = cfg.storno || {}; out.pers = nachSort(cfg.pers); out.set.admin = cfg.set.admin; out.set.kopie = cfg.set.kopie || []; }
    if (me.r.admin) out.set.freiMail = cfg.set.freiMail || [];
    /* Entwürfe für freie Abrechnungen: Admins und „Abrechnen“ sehen alle, andere nur ihre eigenen */
    out.freiEntw = (cfg.freiEntw || []).filter(function (x) { return voll || x.byId === me.id; });
    return out;
  }

  /* ---------- Rabatt je Kiste in Cent ---------- */
  function kistenRabatt(pr, ks, rt, rv) {
    var voll = pr * ks, r = 0;
    if (rt === 'pct') r = Math.round(voll * rv / 100);
    else if (rt === 'abs') r = cent(rv);
    else if (rt === 'fix') r = voll - cent(rv);
    return Math.max(0, Math.min(voll, r));
  }

  /* ---------- Positionen eines Eintrags: Preise werden eingefroren ---------- */
  function posten(cfg, liste, nurStueck) {
    var items = [];
    (Array.isArray(liste) ? liste : []).forEach(function (x) {
      var art = finde(cfg.arts, x && x.a); if (!art) return;
      var st = art.typ === 'stueck', k = (nurStueck || st) ? 0 : ganz(x.k, 999), f = ganz(x.f, 9999);
      if (!k && !f) return;
      var item = { a: art.id, n: art.name, pr: cent(art.preis), ks: st ? 0 : Math.max(1, ganz(art.kiste, 999)), rt: st ? 'none' : (art.rt || 'none'), rv: st ? 0 : (Number(art.rv) || 0), k: k, f: f };
      if (st) item.eh = art.einheit || 'Stück';   /* normaler Artikel: nur Preis je Stück, keine Kiste */
      items.push(item);
    });
    return items;
  }
  /* ---------- Freie Abrechnung: ein Name, ein Tag, Kistenrabatt wählbar ---------- */
  function freiBeleg(cfg, fr) {
    var name = str(fr.name, 60) || 'Freie Abrechnung', z = istTag(fr.z) ? fr.z : '', rab = fr.rab !== false;
    var items = posten(cfg, fr.it), d = { id: '_frei', name: name, modus: 'tag', rabatt: rab, leute: [], mails: [] };
    var b = rechne({ arts: cfg.arts, depts: [d] }, items.length && z ? [{ id: 'frei', d: d.id, z: z, it: items, rab: rab, by: '', at: '' }] : [], d.id, (z || '0000-00').slice(0, 7));
    b.frei = true; b.tag = z; b.mitRabatt = rab; b.items = items;
    return b;
  }

  /* ---------- Abrechnung einer Abteilung für einen Monat ---------- */
  function rechne(cfg, entries, deptId, monat) {
    var dept = finde(cfg.depts, deptId) || { id: deptId, name: deptId, modus: 'tag', leute: [] };
    var mine = entries.filter(function (e) { return e.d === deptId && !e.x && e.z.slice(0, 7) === monat; });
    var person = mine.length ? mine.some(function (e) { return !!e.p; }) : dept.modus === 'person';
    var units = {}, order = [], artInfo = {}, artSeen = [];
    mine.forEach(function (e) {
      var key = e.p ? 'p:' + e.p : 't:' + e.z;
      if (!units[key]) { units[key] = { key: key, z: e.z, p: e.p || null, name: e.pn || '', grp: {}, von: [], am: e.at, vm: [] }; order.push(key); }
      var u = units[key];
      if (e.pn) u.name = e.pn;
      if (e.v && u.vm.indexOf(e.v) < 0) u.vm.push(e.v);
      if (e.by && u.von.indexOf(e.by) < 0) u.von.push(e.by);
      if (e.at > u.am) u.am = e.at;
      (e.it || []).forEach(function (it) {
        var sig = [it.a, it.pr, it.ks, it.rt, it.rv, e.rab ? 1 : 0].join('|');
        if (!u.grp[sig]) u.grp[sig] = { a: it.a, pr: it.pr, ks: it.ks, rt: it.rt, rv: it.rv, rab: !!e.rab, n: 0 };
        u.grp[sig].n += (it.k || 0) * it.ks + (it.f || 0);
        if (!artInfo[it.a]) { artInfo[it.a] = { a: it.a }; artSeen.push(it.a); }
        var ai0 = artInfo[it.a]; ai0.name = it.n; ai0.pr = it.pr; ai0.ks = it.ks; ai0.st = !it.ks; ai0.eh = it.ks ? '' : (it.eh || 'Stück');
      });
    });
    var arts = [];
    cfg.arts.forEach(function (a) { if (artInfo[a.id]) { artInfo[a.id].sorten = a.sorten || ''; arts.push(artInfo[a.id]); } });
    artSeen.forEach(function (id) { if (arts.indexOf(artInfo[id]) < 0) arts.push(artInfo[id]); });

    var pos = {}, posOrder = [], zwischen = 0, rabatt = 0, nRab = 0, pctSet = {}, nurPct = true, kistenGes = 0, flGes = 0, stGes = 0, cum = {}, mArt = {};
    /* Bei Abteilungen pro Tag zählen die Flaschen über den ganzen Monat zusammen: 28 einzelne Flaschen an verschiedenen Tagen ergeben 1 Kiste + 4 Flaschen.
       Der Rabatt für eine volle Kiste fällt an dem Tag an, an dem sie voll wird. Dafür werden die Tage der Reihe nach durchgegangen. */
    if (!person) order.sort(function (a, b) { return units[a].z < units[b].z ? -1 : units[a].z > units[b].z ? 1 : 0; });
    var rows = order.map(function (key) {
      var u = units[key], row = { z: u.z, p: u.p, name: u.name, von: u.von, am: u.am, vm: u.vm, arts: {}, rabatt: 0, betrag: 0 };
      Object.keys(u.grp).forEach(function (sig) {
        var g = u.grp[sig]; if (!g.n) return;
        var dk = g.ks > 0 ? Math.floor(g.n / g.ks) : 0, rest = g.n - dk * g.ks, voll = dk;
        if (!person && g.ks > 0) { var c0 = cum[sig] || 0, c1 = c0 + g.n; cum[sig] = c1; voll = Math.floor(c1 / g.ks) - Math.floor(c0 / g.ks); }
        var jeKiste = g.rab ? kistenRabatt(g.pr, g.ks, g.rt, g.rv) : 0, rab = voll * jeKiste;
        if (!row.arts[g.a]) row.arts[g.a] = { k: 0, f: 0, n: 0, b: 0 };
        row.arts[g.a].k += dk; row.arts[g.a].f += rest; row.arts[g.a].n += g.n; row.arts[g.a].b += g.n * g.pr - rab;
        if (!mArt[g.a]) mArt[g.a] = { n: 0, k: 0, f: 0, b: 0 }; mArt[g.a].b += g.n * g.pr - rab;
        row.rabatt += rab; row.betrag += g.n * g.pr - rab;
        zwischen += g.n * g.pr; rabatt += rab; kistenGes += voll; if (g.ks > 0) flGes += g.n; else stGes += g.n;
        if (rab > 0) { nRab += voll; if (g.rt === 'pct') pctSet[g.rv] = 1; else nurPct = false; }
        var pk = g.a + '|' + g.pr + '|' + g.ks;
        if (!pos[pk]) { pos[pk] = { a: g.a, pr: g.pr, ks: g.ks, k: 0, f: 0, n: 0 }; posOrder.push(pk); }
        pos[pk].k += voll; pos[pk].n += g.n;
      });
      return row;
    }).filter(function (r) { return Object.keys(r.arts).length > 0; });

    if (person) {
      var rang = {}; nachSort(dept.leute).forEach(function (l, i) { rang[l.id] = i; });
      rows.forEach(function (r) { var l = finde(dept.leute || [], r.p); if (l) r.name = l.name; }); /* umbenannt: der aktuelle Name gilt */
      rows.sort(function (a, b) {
        var x = rang[a.p], y = rang[b.p];
        if (x == null && y == null) return a.name.localeCompare(b.name, 'de');
        if (x == null) return 1; if (y == null) return -1; return x - y;
      });
    } else rows.sort(function (a, b) { return a.z < b.z ? -1 : a.z > b.z ? 1 : 0; });

    posOrder.forEach(function (pk) { var q = pos[pk]; q.f = q.n - q.k * q.ks; var m = mArt[q.a]; m.n += q.n; m.k += q.k; m.f += q.f; });
    var positionen = [];
    arts.forEach(function (ai) {
      posOrder.forEach(function (pk) {
        var p = pos[pk]; if (p.a !== ai.a) return;
        if (p.k) positionen.push({ a: p.a, name: ai.name, sorten: ai.sorten || '', typ: 'kiste', ks: p.ks, menge: p.k, einzel: p.pr * p.ks, betrag: p.k * p.pr * p.ks });
        if (p.f) positionen.push({ a: p.a, name: ai.name, sorten: ai.sorten || '', typ: p.ks > 0 ? 'flasche' : 'stueck', eh: ai.eh, ks: p.ks, menge: p.f, einzel: p.pr, betrag: p.f * p.pr });
      });
    });
    var pcts = Object.keys(pctSet);
    return {
      dept: dept, monat: monat, person: person, arts: arts, rows: rows, positionen: positionen, monatArt: mArt,
      zwischen: zwischen, rabatt: rabatt, nRab: nRab, rabPct: (nurPct && pcts.length === 1) ? Number(pcts[0]) : null,
      summe: zwischen - rabatt, kisten: kistenGes, flaschen: flGes, stueck: stGes, leer: rows.length === 0
    };
  }

  /* ---------- Anfragen bearbeiten ----------
     io: { adminKey, cfg(), saveCfg(c), entries(monate|null), add(e), del(ids), mail(o), now(), id(),
           ablegen(o) → { fid, url }, archivAdd(rec), archivListe(), archivHol(id), archivSetze(rec), altVersand() } */
  var APP = 'sve-getraenke-abrechnung', VERSION = 16;
  /* Jede Antwort trägt die Kennung, damit die App merkt, wenn sie mit einem anderen Skript verbunden ist */
  function handle(req, io) { var r = bearbeite(req, io); r.app = APP; r.v = VERSION; return r; }
  function bearbeite(req, io) {
    var cfg = io.cfg(), me = werBin(cfg, req.k, io.adminKey);
    if (!me) return { ok: false, error: 'Kein Zugang. Der Link ist ungültig oder gesperrt.', code: 'auth' };
    var a = req.a || 'init';

    function monate(list) { return (Array.isArray(list) ? list : []).filter(istMonat).slice(0, 24); }
    function meine(list) { list = list.filter(function (e) { return !e.x; }); return (me.r.admin || me.r.verw || me.r.abr) ? list : list.filter(function (e) { return darfEin(me, e.d); }); }
    function antwort(extra) { var o = { ok: true, me: me, cfg: sicht(cfg, me) }; for (var k in extra) o[k] = extra[k]; return o; }
    function dateiOk(x) { var d = str(x, 90).replace(/[^\wäöüÄÖÜß.-]/g, '_'); return /\.pdf$/i.test(d) ? d : (d || 'Abrechnung') + '.pdf'; }
    /* Kopfdaten der PDF einfrieren, damit sie im Archiv genauso wieder gezeichnet wird */
    function erstellt(rq) { var e = rq.erstellt || {}; return { am: istTag(e.am) ? e.am : io.now().slice(0, 10), von: me.name, hinweis: cfg.set.hinweis || '', tage: cfg.set.tage !== false }; }
    /* PDF in Google Drive ablegen; klappt das nicht, geht trotzdem nichts verloren */
    function ablegen(pdf, datei, ordner) {
      try { return io.ablegen({ pdf: String(pdf), datei: datei, ordner: ordner }) || {}; }
      catch (err) { return { fehler: 'Die PDF konnte nicht in Google Drive abgelegt werden (' + (err && err.message ? err.message : err) + '). Im Google-Skript einmal „einrichten“ ausführen und den Zugriff auf Drive erlauben.' }; }
    }
    function archiviere(r, ab) {
      r.id = r.id || io.id(); r.at = io.now(); r.by = me.name; r.byId = me.id; r.fid = ab.fid || ''; r.url = ab.url || ''; r.nach = [];
      io.archivAdd(r); return r;
    }
    function leicht(r) { var o = {}; for (var k in r) if (k !== 'beleg') o[k] = r[k]; o.hatBeleg = !!r.beleg; return o; }

    if (a === 'init' || a === 'load') {
      var ms = monate(req.monate);
      return antwort({ ent: meine(io.entries(ms)), monate: ms });
    }

    if (a === 'buchen') {
      var b = req.e || {}, dept = finde(cfg.depts, b.d);
      if (!dept) return { ok: false, error: 'Diese Abteilung gibt es nicht mehr.' };
      if (!darfEin(me, dept.id)) return { ok: false, error: 'Für diese Abteilung darfst du nicht eintragen.' };
      var person = dept.modus === 'person', pl = null;
      if (person) {
        if (!istMonat(b.z)) return { ok: false, error: 'Monat fehlt.' };
        pl = finde(dept.leute || [], b.p);
        if (!pl) return { ok: false, error: 'Diese Person steht nicht mehr in der Liste.' };
      } else if (!istTag(b.z)) return { ok: false, error: 'Datum fehlt.' };
      var items = posten(cfg, b.it, person);
      var monat = b.z.slice(0, 7), wunschId = /^[a-z0-9]{8,40}$/i.test(String(b.id || '')) ? String(b.id) : null;
      if (wunschId) {
        var schon = io.entries([monat]);
        if (schon.some(function (e) { return e.id === wunschId; })) return antwort({ ent: meine(schon), monate: [monat], schon: true });
      }
      if (person) {
        var alt = io.entries([monat]).filter(function (e) { return e.d === dept.id && e.p === pl.id && e.z === b.z; }).map(function (e) { return e.id; });
        if (alt.length) io.del(alt);
      } else if (!items.length) return { ok: false, error: 'Bitte mindestens eine Menge eintragen.' };
      if (items.length) {
        var e = { id: wunschId || io.id(), d: dept.id, dn: dept.name, z: b.z, it: items, rab: !!dept.rabatt, by: me.name, byId: me.id, at: io.now() };
        if (person) { e.p = pl.id; e.pn = pl.name; }
        var vm0 = str(b.v, 120); if (vm0) e.v = vm0;
        io.add(e);
      }
      return antwort({ ent: meine(io.entries([monat])), monate: [monat] });
    }

    if (a === 'aendern') {
      var am = istMonat(req.monat) ? req.monat : null;
      if (!am) return { ok: false, error: 'Monat fehlt.' };
      var alt0 = io.entries([am]).filter(function (e) { return e.id === req.id; })[0];
      if (!alt0) return { ok: false, error: 'Dieser Eintrag ist nicht mehr da.' };
      var eig = alt0.byId === me.id && darfEin(me, alt0.d);
      if (!(me.r.admin || me.r.verw || eig)) return { ok: false, error: 'Das darfst du nicht ändern.' };
      if (cfg.sent && cfg.sent[am + '|' + alt0.d]) return { ok: false, error: 'Diese Abrechnung ist schon verschickt. Setze sie zuerst auf „Wieder offen“.' };
      var dpt = finde(cfg.depts, alt0.d), pers = !!alt0.p;
      var neuIt = posten(cfg, req.e && req.e.it, pers);
      /* Preise bleiben, wie sie beim Eintragen waren: gleicher Artikel behält Preis, Kistengröße und Rabatt */
      neuIt = neuIt.map(function (x) {
        var o = (alt0.it || []).filter(function (y) { return y.a === x.a; })[0];
        if (o) { x.n = o.n; x.pr = o.pr; x.ks = o.ks; x.rt = o.rt; x.rv = o.rv; if (o.eh) x.eh = o.eh; }
        return x;
      });
      var vm1 = str(req.e && req.e.v, 120);
      if (!neuIt.length && !pers) return { ok: false, error: 'Bitte mindestens eine Menge eintragen. Zum Entfernen nimm „Löschen“.' };
      if (!neuIt.length) { io.del([alt0.id]); }
      else {
        var e2 = JSON.parse(JSON.stringify(alt0)); e2.it = neuIt; delete e2.v; if (vm1) e2.v = vm1; e2.ch = me.name; e2.chAt = io.now();
        io.ersetze(alt0.id, e2);
      }
      return antwort({ ent: meine(io.entries([am])), monate: [am] });
    }

    /* ---------- Monat einer Abteilung stornieren (nur Admin): Einträge bleiben im Blatt, zählen aber nirgends mehr ---------- */
    if (a === 'stornieren') {
      if (!me.r.admin) return { ok: false, error: 'Stornieren dürfen nur Admins.' };
      var sdep = finde(cfg.depts, req.d), smon = istMonat(req.monat) ? req.monat : null;
      if (!sdep || !smon) return { ok: false, error: 'Abteilung oder Monat fehlt.' };
      var sids = io.entries([smon]).filter(function (e) { return e.d === sdep.id && !e.x; }).map(function (e) { return e.id; });
      if (!sids.length) return { ok: false, error: 'In diesem Monat gibt es für ' + sdep.name + ' nichts zu stornieren.' };
      var sx = { at: io.now(), by: me.name, grund: str(req.grund, 120) };
      io.markiere(sids, sx);
      cfg = io.cfg(); cfg.storno = cfg.storno || {};
      var sk = smon + '|' + sdep.id, so = cfg.storno[sk] || { ids: [], n: 0 };
      cfg.storno[sk] = { at: sx.at, by: sx.by, grund: sx.grund || so.grund || '', n: (so.n || 0) + sids.length, ids: (so.ids || []).concat(sids).slice(-400) };
      /* Status „gesendet/erledigt“ zurücksetzen, die alte PDF im Archiv bleibt und wird markiert */
      var war = !!(cfg.sent && cfg.sent[sk]); if (war) delete cfg.sent[sk];
      io.saveCfg(cfg);
      io.archivListe().filter(function (r) { return r.art === 'abt' && r.d === sdep.id && r.zeit === smon && !r.storno; }).forEach(function (r) {
        var voll = io.archivHol(r.id); if (voll) { voll.storno = { at: sx.at, by: sx.by, grund: sx.grund }; io.archivSetze(voll); }
      });
      return antwort({ ent: meine(io.entries([smon])), monate: [smon], storniert: sids.length, warGesendet: war });
    }
    if (a === 'stornoZurueck') {
      if (!me.r.admin) return { ok: false, error: 'Das dürfen nur Admins.' };
      var zk = String(req.monat) + '|' + String(req.d), zr = (cfg.storno || {})[zk];
      if (!zr) return { ok: false, error: 'Dieses Storno gibt es nicht mehr.' };
      io.markiere(zr.ids || [], null);
      cfg = io.cfg(); delete cfg.storno[zk]; io.saveCfg(cfg);
      return antwort({ ent: meine(io.entries([String(req.monat)])), monate: [String(req.monat)] });
    }
    /* Alte PDFs, die noch lose im Hauptordner liegen, einmalig in Monatsordner einsortieren */
    if (a === 'belegeSortieren') {
      if (!me.r.admin) return { ok: false, error: 'Das dürfen nur Admins.' };
      var zuo = {};
      io.archivListe().forEach(function (r) { if (r.fid && istMonat(String(r.zeit || '').slice(0, 7))) zuo[r.fid] = String(r.zeit).slice(0, 7); });
      var anz = io.sortiereBelege(zuo);
      return antwort({ verschoben: anz });
    }

    if (a === 'loeschen') {
      var mon = istMonat(req.monat) ? req.monat : null;
      var hit = io.entries(mon ? [mon] : null).filter(function (e) { return e.id === req.id; })[0];
      if (!hit) return antwort({ ent: meine(io.entries(mon ? [mon] : [])), monate: mon ? [mon] : [] });
      var eigen = hit.byId === me.id && darfEin(me, hit.d);
      if (!(me.r.admin || me.r.verw || eigen)) return { ok: false, error: 'Das darfst du nicht löschen.' };
      io.del([hit.id]);
      var m2 = hit.z.slice(0, 7);
      return antwort({ ent: meine(io.entries([m2])), monate: [m2] });
    }

    if (a === 'arts') {
      if (!(me.r.admin || me.r.verw)) return { ok: false, error: 'Dafür fehlt dir das Recht „Verwalten“.' };
      var neu = [];
      (Array.isArray(req.data) ? req.data : []).slice(0, 60).forEach(function (x) {
        var name = str(x.name, 40); if (!name) return;
        var stueck = x.typ === 'stueck', rt = stueck ? 'none' : (['pct', 'abs', 'fix', 'none'].indexOf(x.rt) >= 0 ? x.rt : 'none');
        var id = x.id && !finde(neu, x.id) ? str(x.id, 40) : neueId(neu.concat(cfg.arts), name);
        neu.push({ id: id, name: name, sorten: str(x.sorten, 120), preis: Math.round(zahl(x.preis, 0, 9999) * 100) / 100,
          typ: stueck ? 'stueck' : 'kiste', einheit: stueck ? (str(x.einheit, 14) || 'Stück') : '', kiste: stueck ? 0 : Math.max(1, ganz(x.kiste, 999)),
          rt: rt, rv: rt === 'none' ? 0 : Math.round(zahl(x.rv, 0, 9999) * 100) / 100, aktiv: x.aktiv !== false });
      });
      if (!neu.length) return { ok: false, error: 'Mindestens ein Artikel muss bleiben.' };
      cfg.arts = neu; io.saveCfg(cfg);
      return antwort({});
    }

    if (a === 'depts') {
      if (!(me.r.admin || me.r.verw)) return { ok: false, error: 'Dafür fehlt dir das Recht „Verwalten“.' };
      var nd = [];
      (Array.isArray(req.data) ? req.data : []).slice(0, 40).forEach(function (x) {
        var name = str(x.name, 40); if (!name) return;
        var id = x.id && !finde(nd, x.id) ? str(x.id, 40) : neueId(nd.concat(cfg.depts), name);
        var leute = [];
        (Array.isArray(x.leute) ? x.leute : []).slice(0, 80).forEach(function (l) {
          var ln = str(l.name, 40); if (!ln) return;
          leute.push({ id: l.id && !finde(leute, l.id) ? str(l.id, 40) : neueId(leute, ln), name: ln });
        });
        nd.push({ id: id, name: name, modus: x.modus === 'person' ? 'person' : 'tag', rabatt: !!x.rabatt, mails: mailsVon(x.mails), leute: nachSort(leute), aktiv: x.aktiv !== false });
      });
      if (!nd.length) return { ok: false, error: 'Mindestens eine Abteilung muss bleiben.' };
      cfg.depts = nd; io.saveCfg(cfg);
      return antwort({});
    }

    if (a === 'leute') { /* Personenliste einer Abteilung, auch für alle, die dort eintragen dürfen */
      var dl = finde(cfg.depts, req.d);
      if (!dl) return { ok: false, error: 'Diese Abteilung gibt es nicht mehr.' };
      if (!(me.r.admin || me.r.verw || darfEin(me, dl.id))) return { ok: false, error: 'Das darfst du hier nicht.' };
      var nl = [];
      (Array.isArray(req.data) ? req.data : []).slice(0, 80).forEach(function (l) {
        var ln = str(l.name, 40); if (!ln) return;
        nl.push({ id: l.id && !finde(nl, l.id) ? str(l.id, 40) : neueId(nl, ln), name: ln });
      });
      dl.leute = nachSort(nl); io.saveCfg(cfg);
      return antwort({});
    }

    if (a === 'set') {
      if (!me.r.admin) return { ok: false, error: 'Das darf nur ein Admin.' };
      var s = req.data || {};
      var pwAlt = cfg.set.pw;
      cfg.set = { admin: str(s.admin, 40) || cfg.set.admin || 'Admin', hinweis: str(s.hinweis, 300), kopie: mailsVon(s.kopie), tage: s.tage !== false, freiMail: mailsVon(s.freiMail) };
      if (pwAlt) cfg.set.pw = pwAlt;
      io.saveCfg(cfg); me = werBin(cfg, req.k, io.adminKey);
      return antwort({});
    }

    /* Passwort für das Zahnrad: sperrt die Einstellungen auf dem Gerät, zusätzlich zu den Rechten der Person */
    if (a === 'pw') {
      if (!(me.r.admin || me.r.verw || me.r.abr)) return { ok: false, error: 'Für dich gibt es hier nichts einzustellen.' };
      if (pwGesetzt(cfg) && !pwStimmt(cfg, req.pw)) return { ok: false, error: 'Das Passwort stimmt nicht.', code: 'pw' };
      return antwort({});
    }
    if (a === 'pwSetzen') {
      if (!me.r.admin) return { ok: false, error: 'Das Passwort darf nur ein Admin festlegen.' };
      var neuPw = String(req.pw == null ? '' : req.pw);
      if (neuPw.length < 4 || neuPw.length > 60) return { ok: false, error: 'Das Passwort braucht mindestens 4 Zeichen.' };
      if (pwGesetzt(cfg) && !pwStimmt(cfg, req.alt)) return { ok: false, error: 'Das bisherige Passwort stimmt nicht.', code: 'pw' };
      var salz = io.id();
      cfg.set.pw = { s: salz, h: sha256(salz + neuPw) };
      io.saveCfg(cfg);
      return antwort({});
    }

    if (a === 'person') {
      if (!me.r.admin) return { ok: false, error: 'Das darf nur ein Admin.' };
      var p = req.p || {}, pn = str(p.name, 40);
      if (!pn) return { ok: false, error: 'Name fehlt.' };
      var ex = p.id ? finde(cfg.pers, p.id) : null;
      if (ex) { ex.name = pn; ex.hallo = str(p.hallo, 30); ex.r = rechte(p.r); ex.gesperrt = !!p.gesperrt; if (p.neuerLink) ex.tok = io.id() + io.id(); }
      else { ex = { id: neueId(cfg.pers, pn), name: pn, hallo: str(p.hallo, 30), tok: io.id() + io.id(), r: rechte(p.r), gesperrt: false, seit: io.now() }; cfg.pers.push(ex); }
      cfg.pers = nachSort(cfg.pers);
      io.saveCfg(cfg);
      return antwort({ person: ex.id });
    }

    if (a === 'personWeg') {
      if (!me.r.admin) return { ok: false, error: 'Das darf nur ein Admin.' };
      cfg.pers = cfg.pers.filter(function (x) { return x.id !== req.id; });
      io.saveCfg(cfg);
      return antwort({});
    }

    if (a === 'senden') {
      if (!(me.r.admin || me.r.abr)) return { ok: false, error: 'Dafür fehlt dir das Recht „Abrechnen“.' };
      var sd = finde(cfg.depts, req.d);
      if (!sd || !istMonat(req.monat)) return { ok: false, error: 'Abteilung oder Monat fehlt.' };
      var an = sd.mails || [];
      if (!an.length) return { ok: false, error: 'Für ' + sd.name + ' ist keine E-Mail-Adresse hinterlegt.' };
      if (!req.pdf || String(req.pdf).length > 6000000) return { ok: false, error: 'Die PDF fehlt oder ist zu groß.' };
      var kopie = (cfg.set.kopie || []).filter(function (m) { return an.indexOf(m) < 0; });
      var datei = dateiOk(req.datei);
      io.mail({ an: an, kopie: kopie, betreff: str(req.betreff, 150), text: String(req.text || '').slice(0, 4000), pdf: String(req.pdf), datei: datei });
      var sb = rechne(cfg, io.entries([req.monat]), sd.id, req.monat); sb.erstellt = erstellt(req);
      var ab = ablegen(req.pdf, datei, req.monat);
      archiviere({ art: 'abt', d: sd.id, name: sd.name, zeit: req.monat, summe: sb.summe, an: an, kopie: kopie, wie: 'mail', datei: datei, beleg: sb, betreff: str(req.betreff, 150) }, ab);
      cfg = io.cfg();
      cfg.sent = cfg.sent || {};
      cfg.sent[req.monat + '|' + sd.id] = { at: io.now(), by: me.name, an: an, sum: Math.round(Number(req.summe) || 0) };
      io.saveCfg(cfg);
      return antwort({ gesendet: an, hinweis: ab.fehler || '' });
    }

    /* ---------- Entwürfe für freie Abrechnungen (Personen mit dem Recht „Freie Abrechnung erstellen“) ---------- */
    function pruefeEntwurf(rq) {
      var n = str(rq.name, 60);
      if (!n) return { fehler: 'Bitte oben eintragen, für wen die Abrechnung ist.' };
      if (!istTag(rq.z)) return { fehler: 'Datum fehlt.' };
      var bb = freiBeleg(cfg, { name: n, z: rq.z, rab: rq.rab, it: rq.it });
      if (bb.leer) return { fehler: 'Bitte mindestens eine Menge eintragen.' };
      return { name: n, z: rq.z, rab: rq.rab !== false, it: (Array.isArray(rq.it) ? rq.it : []).map(function (i) { return { a: str(i && i.a, 40), k: ganz(i && i.k, 999), f: ganz(i && i.f, 9999) }; }), summe: bb.summe };
    }
    function entwurfFinden(id) { var l = cfg.freiEntw || []; for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
    function darfEntwurf(x) { return me.r.admin || me.r.abr || x.byId === me.id; }

    if (a === 'freiEntwurf') {
      if (!(me.r.admin || me.r.abr || me.r.frei)) return { ok: false, error: 'Dafür fehlt dir das Recht „Freie Abrechnung erstellen“.' };
      var pe = pruefeEntwurf(req);
      if (pe.fehler) return { ok: false, error: pe.fehler };
      cfg.freiEntw = cfg.freiEntw || [];
      var eid = /^[a-z0-9]{8,40}$/i.test(String(req.id || '')) ? String(req.id) : io.id();
      var en = entwurfFinden(eid);
      if (en && !darfEntwurf(en)) return { ok: false, error: 'Das ist der Entwurf von jemand anderem.' };
      var neu = !en;
      if (!en) { en = { id: eid, by: me.name, byId: me.id, at: io.now() }; cfg.freiEntw.push(en); }
      en.name = pe.name; en.z = pe.z; en.rab = pe.rab; en.it = pe.it; en.summe = pe.summe; en.ch = io.now();
      en.status = 'offen'; delete en.grund;
      if (cfg.freiEntw.length > 200) cfg.freiEntw = cfg.freiEntw.slice(-200);
      io.saveCfg(cfg);
      /* Admins benachrichtigen, aber nur bei neuen oder wieder eingereichten Entwürfen von Personen ohne Abrechnen-Recht */
      var fm = cfg.set.freiMail || [], hin = '';
      if (fm.length && !(me.r.admin || me.r.abr)) {
        try { io.hinweisMail({ an: fm, betreff: 'Freie Abrechnung zur Freigabe: ' + pe.name, text: me.name + ' hat eine freie Abrechnung „' + pe.name + '“ (' + (pe.summe / 100).toFixed(2).replace('.', ',') + ' €) erstellt.\n\nSie wartet in der App auf deine Bestätigung: öffne die App, dort erscheint oben ein Hinweis. Erst nach deiner Freigabe wird sie versendet.' }); }
        catch (err) { hin = 'Die Hinweis-Mail an die Admins konnte nicht verschickt werden.'; }
      }
      return antwort({ entwurf: en.id, neu: neu, hinweis: hin });
    }

    if (a === 'freiEntwurfWeg') {
      var wx = entwurfFinden(String(req.id || ''));
      if (!wx) return antwort({});
      if (!darfEntwurf(wx)) return { ok: false, error: 'Das ist der Entwurf von jemand anderem.' };
      cfg.freiEntw = cfg.freiEntw.filter(function (x) { return x.id !== wx.id; });
      io.saveCfg(cfg);
      return antwort({});
    }

    if (a === 'freiZurueck') {
      if (!(me.r.admin || me.r.abr)) return { ok: false, error: 'Dafür fehlt dir das Recht „Abrechnen“.' };
      var zx = entwurfFinden(String(req.id || ''));
      if (!zx) return { ok: false, error: 'Diesen Entwurf gibt es nicht mehr.' };
      zx.status = 'zurueck'; zx.grund = str(req.grund, 200); zx.von = me.name;
      io.saveCfg(cfg);
      return antwort({});
    }

    /* ---------- Freie Abrechnung: per Mail senden oder exportiert ablegen ---------- */
    if (a === 'frei') {
      if (!(me.r.admin || me.r.abr)) return { ok: false, error: 'Dafür fehlt dir das Recht „Abrechnen“.' };
      var fid = /^[a-z0-9]{8,40}$/i.test(String(req.id || '')) ? String(req.id) : io.id();
      var da = io.archivHol(fid);
      if (da) return antwort({ archiv: leicht(da), schon: true });
      var fname = str(req.name, 60), fwie = req.wie === 'export' ? 'export' : 'mail';
      if (!fname) return { ok: false, error: 'Bitte oben eintragen, für wen die Abrechnung ist.' };
      if (!istTag(req.z)) return { ok: false, error: 'Datum fehlt.' };
      var fb = freiBeleg(cfg, { name: fname, z: req.z, rab: req.rab, it: req.it });
      if (fb.leer) return { ok: false, error: 'Bitte mindestens eine Menge eintragen.' };
      fb.erstellt = erstellt(req); delete fb.items;
      if (!req.pdf || String(req.pdf).length > 6000000) return { ok: false, error: 'Die PDF fehlt oder ist zu groß.' };
      var entwurfVon = ''; if (req.entwurf) { var ee = entwurfFinden(String(req.entwurf)); if (ee) entwurfVon = ee.by; }
      var fan = [], fkopie = [], fdatei = dateiOk(req.datei);
      if (fwie === 'mail') {
        fan = mailsVon(req.an);
        if (!fan.length) return { ok: false, error: 'Bitte eine gültige E-Mail-Adresse eintragen.' };
        fkopie = (cfg.set.kopie || []).filter(function (m) { return fan.indexOf(m) < 0; });
        io.mail({ an: fan, kopie: fkopie, betreff: str(req.betreff, 150), text: String(req.text || '').slice(0, 4000), pdf: String(req.pdf), datei: fdatei });
      } else if (req.kopieMail && (cfg.set.kopie || []).length) {
        fkopie = cfg.set.kopie.slice();
        io.mail({ an: fkopie, kopie: [], betreff: str(req.betreff, 150), text: String(req.text || '').slice(0, 4000), pdf: String(req.pdf), datei: fdatei });
      }
      var fab = ablegen(req.pdf, fdatei, req.z.slice(0, 7));
      if (req.entwurf && cfg.freiEntw) { cfg.freiEntw = cfg.freiEntw.filter(function (x) { return x.id !== String(req.entwurf); }); io.saveCfg(cfg); }
      var frec = archiviere({ id: fid, art: 'frei', name: fname, von: (entwurfVon || ''), zeit: req.z, summe: fb.summe, an: fan, kopie: fkopie, wie: fwie, datei: fdatei, beleg: fb, betreff: str(req.betreff, 150) }, fab);
      return antwort({ archiv: leicht(frec), hinweis: fab.fehler || '' });
    }

    /* ---------- Monatsabrechnung per Teilen (z. B. WhatsApp) als erledigt merken, oder wieder öffnen ---------- */
    if (a === 'erledigt' || a === 'offen') {
      if (!(me.r.admin || me.r.abr)) return { ok: false, error: 'Dafür fehlt dir das Recht „Abrechnen“.' };
      var ed = finde(cfg.depts, req.d);
      if (!ed || !istMonat(req.monat)) return { ok: false, error: 'Abteilung oder Monat fehlt.' };
      cfg.sent = cfg.sent || {};
      if (a === 'erledigt') cfg.sent[req.monat + '|' + ed.id] = { at: io.now(), by: me.name, an: [], wie: 'geteilt', sum: Math.round(Number(req.summe) || 0) };
      else delete cfg.sent[req.monat + '|' + ed.id];
      io.saveCfg(cfg);
      return antwort({});
    }

    /* ---------- Kopie einer geteilten Monatsabrechnung an die Kopie-Adresse ---------- */
    if (a === 'kopieMail') {
      if (!(me.r.admin || me.r.abr)) return { ok: false, error: 'Dafür fehlt dir das Recht „Abrechnen“.' };
      var kd = finde(cfg.depts, req.d), kan = (cfg.set.kopie || []).slice();
      if (!kd || !istMonat(req.monat)) return { ok: false, error: 'Abteilung oder Monat fehlt.' };
      if (!kan.length) return { ok: false, error: 'In den Einstellungen ist keine Kopie-Adresse eingetragen.' };
      if (!req.pdf || String(req.pdf).length > 6000000) return { ok: false, error: 'Die PDF fehlt oder ist zu groß.' };
      var kdatei = dateiOk(req.datei);
      io.mail({ an: kan, kopie: [], betreff: str(req.betreff, 150), text: String(req.text || '').slice(0, 4000), pdf: String(req.pdf), datei: kdatei });
      var kb = rechne(cfg, io.entries([req.monat]), kd.id, req.monat); kb.erstellt = erstellt(req);
      var kab = ablegen(req.pdf, kdatei, req.monat);
      archiviere({ art: 'abt', d: kd.id, name: kd.name, zeit: req.monat, summe: kb.summe, an: [], kopie: kan, wie: 'export', datei: kdatei, beleg: kb, betreff: str(req.betreff, 150) }, kab);
      return antwort({ gesendet: kan, hinweis: kab.fehler || '' });
    }

    /* ---------- Archiv: alles, was die App verlassen hat ---------- */
    if (a === 'archiv') {
      if (!(me.r.admin || me.r.abr)) return { ok: false, error: 'Dafür fehlt dir das Recht „Abrechnen“.' };
      return antwort({ archiv: io.archivListe().map(leicht), alt: io.altVersand() });
    }
    if (a === 'archivEins') {
      if (!(me.r.admin || me.r.abr)) return { ok: false, error: 'Dafür fehlt dir das Recht „Abrechnen“.' };
      var ae = io.archivHol(String(req.id || ''));
      if (!ae) return { ok: false, error: 'Diese Abrechnung gibt es im Archiv nicht.' };
      return antwort({ eins: ae });
    }
    if (a === 'nachsenden') {
      if (!(me.r.admin || me.r.abr)) return { ok: false, error: 'Dafür fehlt dir das Recht „Abrechnen“.' };
      var nr = io.archivHol(String(req.id || ''));
      if (!nr) return { ok: false, error: 'Diese Abrechnung gibt es im Archiv nicht.' };
      var nan = mailsVon(req.an);
      if (!nan.length) return { ok: false, error: 'Bitte eine gültige E-Mail-Adresse eintragen.' };
      if (!nr.fid && (!req.pdf || String(req.pdf).length > 6000000)) return { ok: false, error: 'Die PDF fehlt.' };
      var nkopie = (cfg.set.kopie || []).filter(function (m) { return nan.indexOf(m) < 0; });
      io.mail({ an: nan, kopie: nkopie, betreff: str(req.betreff, 150) || nr.betreff || 'Getränkeabrechnung', text: String(req.text || '').slice(0, 4000), fid: nr.fid || null, pdf: nr.fid ? null : String(req.pdf), datei: nr.datei || 'Abrechnung.pdf' });
      nr.nach = (nr.nach || []).concat([{ at: io.now(), by: me.name, an: nan }]).slice(-20);
      io.archivSetze(nr);
      return antwort({ archiv: leicht(nr), gesendet: nan });
    }

    return { ok: false, error: 'Unbekannte Anfrage.' };
  }

  return { APP: APP, VERSION: VERSION, nachSort: nachSort, sha256: sha256, posten: posten, freiBeleg: freiBeleg, standard: standard, handle: handle, rechne: rechne, kistenRabatt: kistenRabatt, darfEin: darfEin, darfIrgendEin: darfIrgendEin, mailsVon: mailsVon, cent: cent, istTag: istTag, istMonat: istMonat, finde: finde };
})();
