# 🎱 Powerball Explorer

A responsive Powerball results explorer built with Node.js, HTML, CSS and Javascript. It uses the DrawAnalytics API for real historical Powerball winning numbers and has no npm dependencies.

- **GitHub:** https://github.com/Soumaya896/powerball-explorer
- Demo video: https://youtu.be/_YksYOFHtXg 
- **Deployed website (Lb01):** http://16.60.27.181 
- **Author:** Soumaya (GitHub: [Soumaya896](https://github.com/Soumaya896))

## Why this application is useful

One place to browse historical Powerball drawings, search and filter them, explore number frequencies, generate a random ticket and compare a ticket with a past drawing. It is informational only: past results do not predict future outcomes.

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

Browser
   |
   v
Lb01 (HAProxy, port 80, round-robin)
   |                         |
   v                         v
Web01 (18.171.55.145:3000)   Web02 (35.178.40.132:3000)
Node app (systemd service)   Node app (systemd service)

Each web server runs the Node.js app as a systemd service on port 3000, and Lb01 forwards traffic directly to that port. A helper script, `deploy/setup-webserver.sh`, is included to automate the setup.

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

### 2. Configure Lb01 (HAProxy)

Lb01 (16.60.27.181) already runs HAProxy, so I changed its existing config to send traffic to port 3000 on both web servers:

```bash
ssh ubuntu@16.60.27.181
sudo cp /etc/haproxy/haproxy.cfg /etc/haproxy/haproxy.cfg.bak
sudo nano /etc/haproxy/haproxy.cfg
```

The backend section is:

```text
backend web_servers
    balance roundrobin
    option httpchk GET /api/health
    server web-01 18.171.55.145:3000 check
    server web-02 35.178.40.132:3000 check
```

Check the file and reload HAProxy:

```bash
sudo haproxy -c -f /etc/haproxy/haproxy.cfg
sudo systemctl reload haproxy
```

Round-robin alternates requests between the two servers. The health check on `/api/health` stops sending traffic to a server that is down. `deploy/nginx-loadbalancer.conf` is an alternative for nginx-based load balancers and was not used here.

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

- DrawAnalytics: [Powerball results data](https://www.drawanalytics.com).
- Node.js: https://nodejs.org/.
- nginx: https://nginx.org/.
- Powerball prize information: https://www.powerball.com/powerball-prize-chart.

## Login credentials

None. The application is public and read-only.

## Disclaimer

For information and entertainment only. Lottery drawings are random; historical frequencies do not predict future results. Verify any ticket with the official lottery.
