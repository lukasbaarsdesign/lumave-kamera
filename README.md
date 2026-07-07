# Lumave — Kamera-App

Eigenständige, statische Web-App „Lumave – Deine Hochzeitskamera" (Gäste-Tool).
Deployt separat von der Marketing-Seite über **Netlify (Auto-Deploy bei Push)**.

## Struktur
```
index.html          → Weiterleitung auf ./app/
app/                → App (index.html + app.css + app.js)
assets/fonts, logo  → gebündelte Fonts + Logos (self-contained)
netlify.toml        → publish = "." , kein Build
```

## Live-Update
```
git add -A && git commit -m "..." && git push
```
→ Netlify deployt automatisch (~1 Min).

## Timer-Modus
Standard: 20-Sekunden-Testmodus (`TEST_DEVELOP_MS` in `app/app.js`).
Echte 48 Stunden: `?real=1` an die URL anhängen.

> Diese App wird von einem Teammitglied gepflegt; dieser Ordner ist die
> deploy-fertige, self-contained Kopie (Quelle: `deploy/` im Marketing-Projekt).
