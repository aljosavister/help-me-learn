# Namestitev na Raspberry Pi / Linux strežnik

Ta dokument opisuje tipično namestitev projekta na Raspberry Pi (ali katerikoli Linux), tako da backend (FastAPI) in frontend (statični build) tečeta kot `systemd` servisa.

## 1. Priprava sistema

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip nodejs npm git
```

Kloniraj repozitorij:

```bash
cd /home/<user>
git clone https://github.com/<user>/help-me-learn.git
cd help-me-learn
```

## 2. Ustvari virtualno okolje in namesti backend odvisnosti

```bash
./setup_venv.sh
```

Skripta ustvari mapo `.venv/`, posodobi `pip` in namesti vse iz `requirements.txt`. Ko želiš ročno zagnati API, aktiviraj okolje z `source .venv/bin/activate`.

## 3. Namesti Node odvisnosti in zgradi frontend

```bash
cd frontend
npm install
VITE_API_BASE=http://<IP-od-streznika>:8000 npm run build
cd ..
```

Gornji ukaz ustvari statično mapo `frontend/dist` in nastavi URL API-ja, ki ga bo frontend uporabljal.

## 4. Ustvari `systemd` servisa

Primeri konfiguracij so v mapi `systemd/`:

- `systemd/german-backend.service.example`
- `systemd/german-frontend.service.example`

Kopiraj in prilagodi oba fajla (popravi `User`, `WorkingDirectory`, poti do `.venv` ali `serve`, porte …):

```bash
sudo cp systemd/german-backend.service.example /etc/systemd/system/german-backend.service
sudo cp systemd/german-frontend.service.example /etc/systemd/system/german-frontend.service
sudo nano /etc/systemd/system/german-backend.service
sudo nano /etc/systemd/system/german-frontend.service
```

Nato naloži spremembe in omogoči servisa:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now german-backend.service
sudo systemctl enable --now german-frontend.service
```

Stanje preveri z:

```bash
sudo systemctl status german-backend.service
sudo systemctl status german-frontend.service
```

Frontend bo privzeto dostopen na `http://<IP-od-streznika>:4173`, API pa na `http://<IP-od-streznika>:8000`.

## 5. Posodabljanje

Pri novi verziji:

```bash
git pull
./setup_venv.sh            # posodobi Python odvisnosti
cd frontend && npm install && VITE_API_BASE=... npm run build && cd ..
sudo systemctl restart german-backend.service
sudo systemctl restart german-frontend.service
```

## 6. Nastavitve adaptivnega načina (frontend)

Privzete konstante (definirane v `frontend/src/App.jsx`):

- `ADAPTIVE_AFTER_CYCLES = 5` — po toliko ciklih se lahko vklopi adaptivni način.
- `MIN_ATTEMPTS_FOR_ADAPTIVE = 25` — minimalno število poskusov pred adaptivnim načinom.
- `HIGH_ACCURACY_THRESHOLD = 0.88` — prag uspešnosti (88%) za preklop.

Kdaj se vklopi adaptivni način: če je trenutni cikel > `ADAPTIVE_AFTER_CYCLES` **ali** če ima uporabnik vsaj `MIN_ATTEMPTS_FOR_ADAPTIVE` poskusov in uspešnost ≥ `HIGH_ACCURACY_THRESHOLD`. Za spremembo vedenja prilagodite te tri vrednosti in ponovno zgradite frontend (`npm run build`).

## 6. Ročni razvoj / testiranje

- `start.sh` in `stop.sh` (v korenu repoja) omogočata lokalni zagon backend + frontend dev strežnikov.
- CLI tutor ostaja dosegljiv z `python3 learn.py`.

S tem so vse komponente pripravljene za samodejni zagon ob vsakem restartu naprave.
