# 🎱 Powerball Explorer

A web application that lets you **browse, search, filter, sort and analyse Powerball lottery drawings**, check whether a ticket won, and generate random Quick Pick numbers. Data comes from the **Powerball API on RapidAPI**.

- 🎥 **Demo video (≤ 2 min):** `PASTE_YOUR_VIDEO_LINK_HERE`
- 🌐 **Live site (load balancer):** `http://PASTE_LB01_IP_OR_DOMAIN`
- 👩‍💻 **Author:** Soumaya (GitHub: [Soumaya896](https://github.com/Soumaya896)) - t.soumaya@alustudent.com

> **Why it is useful:** players and pool managers can verify tickets against any past draw, see which numbers are "hot", "cold" or overdue, and look up any draw by date, all in one clean interface.

---

## Features

| Feature | Details |
|---|---|
| Data sources | Latest drawing, latest 10, all drawings, drawings between two dates, drawing on a specific date |
| **Search** | Type a number or part of a date (`23`, `2025-08`, `5 12 40`) |
| **Filter** | By Powerball number, Power Play multiplier and year |
| **Sort** | By date, Powerball or sum of the five numbers (ascending / descending) |
| **Statistics** | Most / least drawn numbers, most drawn Powerballs, overdue numbers (bar charts) |
| **Ticket checker** | Compares your numbers with a draw and shows the prize (official Powerball prize table) |
| **Quick Pick** | Random valid ticket |
| **Error handling** | Invalid dates/numbers, API key rejected (401/403), rate limit (429), API down (5xx), timeouts, invalid JSON, "no drawing that day". Clear banners are shown in the UI. If the API is down, the last cached results are shown with a warning. |
| **Security** | API key lives only in the server `.env` (git-ignored) and is never sent to the browser. Input is validated server-side, static files are protected from path traversal, strict Content-Security-Policy, no `innerHTML` (XSS-safe). |
| **Performance** | In-memory cache (default 5 min) + retry on upstream 5xx |
| **Demo mode** | With no API key the app serves generated demo data so it can always be run and tested |

## Tech

Node.js 18+ (**zero npm dependencies**), plain HTML/CSS/JavaScript frontend, nginx for reverse proxy and load balancing.

```
powerball-explorer/
├── server.js              # backend: API proxy, cache, validation, static files
├── lib/                   # env loader, response normalizer, demo data
├── public/                # frontend (index.html, style.css, app.js)
├── test/test.js           # automated tests (npm test)
├── deploy/                # setup script + load balancer configs
├── .env.example           # copy to .env and add your key
└── .gitignore             # keeps .env (your API key) out of GitHub
```

---

## API used

**Powerball API** by Avora Tech on RapidAPI: <https://rapidapi.com/avoratechnology/api/powerball>

Endpoints used: *Latest Drawing, Latest 10 Drawings, All Drawings, Drawing by Date, Drawings Between Dates*. (Check Ticket and Quick Pick are also implemented locally using the official prize table, so they work even when the API is slow.)

Credit and thanks to **Avora Tech**, the author of the API. Prize table: <https://www.powerball.com/powerball-prize-chart>.

---

## Run locally

Requirements: [Node.js 18 or newer](https://nodejs.org).

```bash
git clone https://github.com/Soumaya896/powerball-explorer.git
cd powerball-explorer
cp .env.example .env        # Windows: copy .env.example .env
```

Open `.env` and set `API_KEY` (see the API section above; get it from RapidAPI → Powerball → *Code Snippets*). Also copy the **exact base URL, host and endpoint paths** from the same *Code Snippets* tab into `API_BASE_URL`, `API_HOST` and the `PATH_*` lines if they differ from the defaults.

```bash
npm start
# open http://localhost:3000
npm test      # optional: run the automated tests
```

No API key? Leave `API_KEY` empty and the app runs in **demo mode** (a badge at the top shows which mode is active).

---

## Deployment (Web01, Web02 and Lb01)

Architecture:

```
 user ──► Lb01 (nginx, round-robin) ──► Web01 (nginx :80 ─► Node :3000)
                                    └─► Web02 (nginx :80 ─► Node :3000)
```

### 1. On **each** web server (Web01 and Web02)

```bash
ssh ubuntu@WEB01_IP        # then repeat everything for WEB02_IP
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/Soumaya896/powerball-explorer.git
cd powerball-explorer/deploy
sudo SERVER_NAME=web-01 REPO_URL=https://github.com/Soumaya896/powerball-explorer.git bash setup-webserver.sh
#                 ^ use web-02 on Web02
sudo nano /opt/powerball-explorer/.env     # put your API_KEY (and the base URL/paths from RapidAPI)
sudo systemctl restart powerball
curl -i http://localhost/api/health        # should return {"status":"ok","server":"web-01",...}
```

The script installs Node.js and nginx, clones the repo to `/opt/powerball-explorer`, creates a **systemd** service (auto-restart, starts on boot) and an nginx reverse proxy from port 80 to the Node app on port 3000. The `.env` file (with the key) is created on the server only, never in GitHub.

### 2. On the load balancer (Lb01)

```bash
ssh ubuntu@LB01_IP
sudo apt-get update && sudo apt-get install -y nginx
sudo nano /etc/nginx/sites-available/powerball-lb     # paste deploy/nginx-loadbalancer.conf
# replace WEB01_IP and WEB02_IP with the real addresses
sudo ln -sf /etc/nginx/sites-available/powerball-lb /etc/nginx/sites-enabled/powerball-lb
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

(If your Lb01 uses HAProxy instead, use `deploy/haproxy.cfg`.)

Configuration notes: the `upstream` block uses **round-robin** with `max_fails/fail_timeout`, and `proxy_next_upstream` retries on the other server if one fails; headers `Host`, `X-Real-IP` and `X-Forwarded-For` are forwarded.

### 3. Verify the load balancing

Every response carries an `X-Served-By` header (`web-01` / `web-02`), and the page shows it in the top-right badge.

```bash
for i in 1 2 3 4 5 6; do curl -s -o /dev/null -D - http://LB01_IP/api/health | grep -i x-served-by; done
```

Expected output alternates `web-01`, `web-02`, `web-01`, … Also try stopping one server (`sudo systemctl stop powerball` on Web01): the site keeps working through Web02 (zero downtime).

---

## Challenges and how I solved them

| Challenge | Solution |
|---|---|
| Keeping the API key secret | All API calls go through the Node backend; the key is read from `.env` (git-ignored) and the browser never sees it. A test checks that the key never appears in responses. |
| Unknown / varying response formats from the API | A `normalizer` converts many possible shapes (arrays, nested `data`, string or array numbers, different date formats) into one clean format. |
| API downtime and rate limits | Timeouts, one retry, friendly error messages, and a stale-cache fallback. |
| Proving load balancing works | Added the `X-Served-By` header and badge in the UI. |
| Demoing without burning API quota | Cache + demo mode. |

## Credits

- **Powerball API**: Avora Tech via [RapidAPI](https://rapidapi.com/avoratechnology/api/powerball)
- Powerball prize structure: [powerball.com](https://www.powerball.com)
- Built with Node.js and nginx; no third-party libraries.

## Login / credentials for graders

The app has **no login**. The API key for the grader is provided in the assignment submission comment (as required), not in this repository.

*For entertainment and information only. Please play responsibly.*
