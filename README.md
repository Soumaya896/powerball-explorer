# 🎱 Powerball Explorer

A responsive Powerball results explorer built with Node.js, HTML, CSS and Javascript. It uses the DrawAnalystics API for real historical Powerball winning numbers and has no npm dependencies.

- **GitHub:** https://github.com/Soumaya896/powerball-explorer
- **Demo video (maximum 2 minutes):** add your video URL here after recording
- **Deployed website (Lb01):** add your Lb01 public IP or domain after deployment
- **Author:** Soumaya (GitHub: [Soumaya896](https://github.com/Soumaya896))

## Why this application is useful

The application gives users one place to browse historical Powerball drawings, search and filter results, explore number frequencies, generate a valid random ticket and compare a ticket with a selected historical drawing. It is an informational tool only: past results do not predict future lottery outcomes.

## Features

- Latest drawing, latest 10 drawings, full available history, date lookup and date-range lookup.
- Search by number or date.
- Filter by Powerball number, multiplier and year.
- Sort by date, Powerball number or sum of white balls.
- Statistics: most/least frequent white balls, most frequent Powerballs and numbers with the longest current gap in the loaded results.
- Ticket checker for a selected historical drawing.
- Quick Pick generator (5 distinct white balls from 1–69 and one Powerball from 1–26).
- Clear validation and API/network error messages.
- Five-minute in-memory cache and stale-cache fallback when the upstream service is temporarily unavailable.
- Health endpoint and `X-Served-By` response header for load-balancer verification.

## External API and attribution

**Source:** DrawAnalytics, Powerball results (https://www.drawanalytics.com).

- Endpoint used: https://www.drawanalytics.com/api/v1/california/powerball/results
- Data used by the app: draw date, the five white-ball numbers, the Powerball and the multiplier.
- Secrets: none are stored in this repository. Any settings or keys go in a local `.env` file, which is excluded by `.gitignore`.

DrawAnalytics is a third-party data provider, not an official Powerball service. Verify results with the official lottery source if you use them for a real-world decision.

## Project structure

```text
powerball-explorer/
├── server.js
├── package.json
├── .env.example
├── .gitignore
├── README.md
├── lib/
│   ├── env.js
│   ├── mock.js
│   └── normalize.js
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── test/
│   └── test.js
└── deploy/
    ├── setup-webserver.sh
    ├── nginx-loadbalancer.conf
    └── haproxy.cfg
```

## Run locally on Windows

Requirements: Node.js 18 or newer.

1. Download or clone this repository.
2. Open Command Prompt in the project folder.
3. Optional: copy `.env.example` to `.env`and adjust the settings if needed.
4. Install dependencies (there are none, but this confirms the npm project is readable):

   ```bash
   npm install
   ```

5. Start the application:

   ```bash
   npm start
   ```

6. Open http://localhost:3000.

Keep the terminal window open while using the app. Stop the server with `Ctrl+C`.

Run automated tests:

```bash
npm test
```

### Optional demo mode

To use generated sample data instead of making live API requests, set `USE_MOCK=true` in `.env`, then restart the server. Set it to `false` (or remove it) to use the live public DrawAnalytics data.

## API routes provided by this application

| Route | Purpose |
|---|---|
| `GET /api/health` | Health check, server name and data mode |
| `GET /api/latest` | Most recent drawing |
| `GET /api/latest10` | Ten most recent drawings |
| `GET /api/all` | Available historical drawings (up to 5,000) |
| `GET /api/between?from=YYYY-MM-DD&to=YYYY-MM-DD` | Drawings in a date range |
| `GET /api/date?date=YYYY-MM-DD` | Drawing on one date |
| `GET /api/check?numbers=1,2,3,4,5&powerball=6&date=YYYY-MM-DD` | Compare a ticket with a drawing |
| `GET /api/quickpick` | Generate a random valid ticket |

The backend calls the DrawAnalytics endpoint, normalizes its response into a consistent structure, and never exposes upstream implementation details to the browser. The external data service is read-only.

## Deployment architecture

```text
Browser
   |
   v
Lb01 (nginx, port 80, round-robin)
   |                         |
   v                         v
Web01 (nginx :80)         Web02 (nginx :80)
   |                         |
   v                         v
Node app :3000            Node app :3000
```

The provided deployment script installs Node.js, nginx and Git, configures a `systemd` service for the Node application, and configures nginx on each web server as a reverse proxy.

### 1. Deploy to Web01 and Web02

Repeat these steps on both web servers. Replace the sample IP addresses with the actual addresses supplied for the course environment.

```bash
ssh ubuntu@WEB01_IP
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/Soumaya896/powerball-explorer.git
cd powerball-explorer/deploy
sudo SERVER_NAME=web-01 REPO_URL=https://github.com/Soumaya896/powerball-explorer.git bash setup-webserver.sh
```

On Web02, use:

```bash
ssh ubuntu@WEB02_IP
cd powerball-explorer/deploy
sudo SERVER_NAME=web-02 REPO_URL=https://github.com/Soumaya896/powerball-explorer.git bash setup-webserver.sh
```

The script creates `/opt/powerball-explorer/.env` from `.env.example` when needed. Test each web server:

```bash
curl -i http://localhost/api/health
```

The JSON should show `"status":"ok"` and the appropriate server name. If the repository was already cloned by the script, do not clone it a second time; run the script from the repository's `deploy` directory.

### 2. Configure Lb01

SSH to the load balancer:

```bash
ssh ubuntu@LB01_IP
sudo apt-get update
sudo apt-get install -y nginx
```

Copy the contents of `deploy/nginx-loadbalancer.conf` into:

```bash
sudo nano /etc/nginx/sites-available/powerball-lb
```

Replace `WEB01_IP` and `WEB02_IP` with the real private IP addresses of the two web servers. Then enable the configuration:

```bash
sudo ln -sf /etc/nginx/sites-available/powerball-lb /etc/nginx/sites-enabled/powerball-lb
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

The configuration uses nginx's default round-robin upstream selection and retries another upstream for selected connection and server errors. `deploy/haproxy.cfg` is an alternative configuration if the course load balancer uses HAProxy instead of nginx; do not configure both at the same time.

### 3. Verify load balancing

From a machine that can reach Lb01:

```bash
curl -i http://LB01_IP/api/health
```

Repeat several times and inspect the `X-Served-By` response header. Requests should be served by both `web-01` and `web-02` while both are healthy. You can also open `http://LB01_IP` in a browser.

For a failover test, stop the app on one web server:

```bash
sudo systemctl stop powerball
```

Then request the load balancer URL again. Restore it afterward:

```bash
sudo systemctl start powerball
```

Actual IP addresses and successful deployment must be filled in and verified in the course environment; they are not included in this repository because they are assigned by the course.

## Security and reliability

- No secrets are stored in this repository; any keys or settings go in a local `.env` file.
- `.env` is excluded by `.gitignore`; do not commit secrets if additional services are introduced later.
- External requests are made by the Node.js backend.
- User-supplied dates and ticket numbers are validated server-side.
- Static file serving blocks path traversal.
- The server uses request timeouts, a retry for upstream server errors, caching and a stale-cache fallback.
- The frontend uses `textContent` and DOM element creation for data display rather than injecting API data as HTML.

## Challenges and solutions

| Challenge | Solution |
|---|---|
| The New York State Open Data endpoint returned HTTP 403 errors | Switched to the DrawAnalytics API, then rewrote the response normalizer and the automated tests to match it. |
| DrawAnalytics fields differ from the app's internal format | The normalizer converts the date, winning numbers and multiplier into one constitent draw object. |
| Public API may be unavailable | Added request timeout, retry, caching and stale-cache fallback. |
| Need to demonstrate which web server handled a request | Added `X-Served-By` response header and a server badge in the interface. |
| Need to test without relying on internet access | Kept an optional sample-data mode and automated tests. |

## Credits

- DrawAnalytics: [Powerball results data] (https://www.drawanalytics.com).
- Node.js: https://nodejs.org/.
- nginx: https://nginx.org/.
- Powerball prize information: https://www.powerball.com/powerball-prize-chart.

## Login credentials

There is no application login or password. The application is public and read-only.

## Disclaimer

For information and entertainment only. Lottery drawings are random; historical frequencies do not predict future results. Verify any ticket with the official lottery.
