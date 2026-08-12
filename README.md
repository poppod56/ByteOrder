# ByteOrder

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

A self-serve kiosk ordering system for pop-up kitchens, garden kitchens, and small food venues. Customers scan a QR code on their phone, build their order, and track it in real time. The kitchen sees a live order queue and can print tickets to a Bluetooth receipt printer.

ByteOrder runs in two modes:

| Mode | Who it's for |
|------|-------------|
| **Self-hosted** | Single kitchen, simple env-var login, no external auth service required |
| **Cloud** | Multi-tenant SaaS — each kitchen is isolated by Clerk organisation |

---

## How it works

1. Display the kiosk screen (`/`) — it shows a QR code and the live order queue
2. Customers scan the QR code, enter their name, pick items, and place the order
3. The kitchen admin panel shows a live queue — advance orders through **Pending → In Progress → Ready → Completed**
4. When an order is placed the print service fires a ticket to your receipt printer
5. Customers track their order status in real time on their phone

If you have tables to serve, give each one its own QR code as well — see
[Tables](#tables). Table orders skip the name step and print the table on the
ticket, so staff know where to take the food. The kiosk QR code stays as the
takeaway route.

---

## Architecture

| Service | Stack | Purpose |
|---------|-------|---------|
| `frontend` | React + Vite + Tailwind | Mobile-first customer ordering UI, QR code home screen |
| `admin` | React + Vite + Tailwind + Express | Menu management, order queue, settings, auth |
| `menu-service` | Python / FastAPI | CRUD for categories, items, ingredients, option groups, settings |
| `order-service` | Python / FastAPI + SSE | Order lifecycle, queue position, real-time status streaming |
| `print-service` | Python worker | Subscribes to Redis, POSTs formatted tickets to an HTTP printer endpoint |
| `postgres` | PostgreSQL 16 | Persistent store |
| `redis` | Redis 7 | Pub/sub for real-time SSE updates |

---

## Quick start — self-hosted (Docker Compose)

### Prerequisites

- Docker with Compose v2

### 1. Create `deploy/.env`

```env
AUTH_MODE=self-hosted
POSTGRES_PASSWORD=changeme
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme          # change this
JWT_SECRET=                      # generate: openssl rand -base64 32
```

### 2. Start the stack

```bash
cd deploy
docker compose up -d
```

### 3. Access the apps

| URL | What |
|-----|------|
| `http://localhost:3000` | Customer ordering frontend |
| `http://localhost:3001` | Kitchen admin panel |

### 4. First login

Sign in at the admin panel with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` you set above.

### 5. Customer URL

In self-hosted mode the customer ordering page is served directly at `/order`:

```
http://your-server/order
```

Set the **Frontend URL** in **Admin → Settings** to your public address so the QR code on the kiosk screen is correct.

---

## Kubernetes / Helm — self-hosted

```bash
helm install byteorder deploy/helm/byteorder \
  -n byteorder --create-namespace \
  -f your-values.yaml
```

Minimal `values.yaml` for self-hosted:

```yaml
authMode: self-hosted

selfHosted:
  adminUsername: admin
  adminPassword: "your-strong-password"   # required
  jwtSecret: "your-long-random-string"    # required
  defaultKitchenId: default
  defaultKitchenSlug: my-kitchen          # optional — sets the /k/<slug> alias

postgres:
  enabled: true
  password: changeme

ingress:
  enabled: true
  frontendHost: order.example.com
  adminHost: admin.example.com
  tls:
    enabled: true
    clusterIssuer: letsencrypt-prod
```

---

## Kubernetes / Helm — cloud (multi-tenant SaaS)

Requires a [Clerk](https://clerk.com) application with organisation support enabled.

```yaml
authMode: cloud

clerk:
  publishableKey: "pk_live_..."
  secretKey: "sk_live_..."

postgres:
  enabled: false
  existingSecret: my-db-secret
  existingSecretKey: uri

ingress:
  enabled: true
  frontendHost: order.example.com
  adminHost: admin.example.com
  tls:
    enabled: true
    clusterIssuer: letsencrypt-prod
```

Each Clerk organisation maps to one kitchen. The admin sets a friendly slug in **Admin → Settings**; the customer URL is then `order.example.com/k/<slug>/order`.

---

## Admin panel

### Menu setup

1. **Admin → Menu Management** — create **Categories** (e.g. Burgers, Sides) and **Items** within them
2. **Admin → Ingredients** — create toppings and modifiers
3. Attach ingredients to items in Menu Management:
   - **First click** — optional topping (starts unselected)
   - **Second click** — pre-selected by default
   - **Third click** — removes from item
4. Use **Option Groups** (▼ on each item) for mutually exclusive choices like Size

### Branding

**Admin → Settings** lets you customise:
- Kitchen name and slug
- Brand colours (primary, background, surface, text)
- Logo (uploaded as base64)
- Frontend URL (used to generate every QR code — kiosk and printed table codes)
- Printer URL (for the HTTP print-service)

---

## Printer setup

ByteOrder supports two printer backends:

### Option A — Pi Zero W (BLE printer, recommended)

A Raspberry Pi Zero W acts as a dedicated print client. It auto-registers with the backend and pairs to a Bluetooth receipt printer via BLE.

**Setup:**

1. Flash Raspberry Pi OS Bookworm Lite to a micro-SD card
2. Copy the `pi-printer-client/` directory to the Pi and run the installer:
   ```bash
   sudo bash install.sh
   ```
3. On first boot the Pi broadcasts a `ByteOrder-XXXXXX` WiFi network
4. Connect your phone to it — a setup page opens automatically (captive portal)
5. Enter your WiFi credentials and the ByteOrder API base URL
6. Note the **claim code** shown on the setup page (6 hex characters)
7. In **Admin → Printers**, enter the claim code and a name for the printer
8. The printer is now live — orders will print automatically

### Option B — HTTP printer (ble-printer-server)

Run [ble-printer-server](https://github.com/proffalken/ble-print-server) on any machine next to the printer:

```bash
docker run -d --privileged --net=host \
  ghcr.io/proffalken/ble-print-server:latest
```

Then set the printer URL in **Admin → Settings → Printer URL** to `http://<machine-ip>:8080`.

---

## QR code

The kiosk home screen (`/`) shows a QR code that links customers to `/order` (self-hosted) or `/k/<slug>/order` (cloud). Set **Frontend URL** in **Admin → Settings** to your public-facing address.

---

## Tables

Table ordering is optional. Without it every order is a takeaway collected at the
counter; with it, each table gets its own QR code and its number reaches the
kitchen on the ticket.

### Setting up

1. Set **Frontend URL** in **Admin → Settings** first — printed QR codes are built
   from it, and the admin panel is usually on a different address to the customer
   site. Get this wrong and the whole sheet points somewhere useless.
2. In **Admin → Tables**, add your tables. Enter a name and a count to create a
   numbered run (`Table` × 4 gives Table 1 to Table 4), or a count of 1 to name a
   single table exactly (`Window seat`). Names must be unique — they are what the
   kitchen reads off the ticket.
3. Click **Print QR sheet** and stick one code on each table.

### What changes for a table order

| | Kiosk QR (takeaway) | Table QR |
|---|---|---|
| Customer enters a name | Yes | No — the table is the identity |
| Printed ticket | `Name: Alice` | `TABLE: Table 5` above the name |
| Order queue / history | Marked **Takeaway** | Shows the table |
| Tracking page | "Ready to collect" | "On its way to Table 5" |

Customers can order again for the same table from the tracking page, so a second
round does not need another scan.

### Replacing a leaked code

A QR code stuck on a table can be photographed and reused from anywhere. If that
happens, use **New QR** on that table: it issues a fresh code and the old one
stops working immediately, with no grace period. Reprint the sheet and replace
that sticker — the admin panel keeps reminding you until you do.

Renaming a table does **not** change its code, so stickers keep working. Removing
a table stops its code working but leaves past orders showing the name they were
placed under.

---

## Testing locally

### Unit tests

```bash
cd order-service   && pip install -r requirements.txt && python -m pytest tests/ -v
cd menu-service    && pip install -r requirements.txt && python -m pytest tests/ -v
cd print-service   && pip install -r requirements.txt && python -m pytest tests/ -v
cd pi-printer-client && pip install -r requirements.txt && python -m pytest tests/ -v
cd frontend && npm install && npm test -- --run
cd admin    && npm install && npm test          # Express/server tests (jest)
cd admin    && npx vitest run src               # React component tests
```

### Migration tests (needs PostgreSQL)

The startup migrations are Postgres-specific, so they are skipped unless a
database is provided. They build the pre-migration schema in a throwaway
namespace and never touch application data:

```bash
docker run -d --rm --name bo-migtest \
  -e POSTGRES_USER=byteorder -e POSTGRES_PASSWORD=byteorder \
  -e POSTGRES_DB=byteorder_migrationtest -p 55432:5432 postgres:16

cd order-service
ORDER_SERVICE_TEST_DATABASE_URL=postgresql://byteorder:byteorder@localhost:55432/byteorder_migrationtest \
  python -m pytest tests/test_migrations_postgres.py -v

docker rm -f bo-migtest
```

### Running the whole stack

```bash
cd deploy
cat > .env <<'ENV'
AUTH_MODE=self-hosted
DEFAULT_KITCHEN_ID=default
POSTGRES_PASSWORD=byteorder
ADMIN_USERNAME=admin
ADMIN_PASSWORD=localtest123
JWT_SECRET=local-testing-only-rotate-this
ENV
docker compose up -d --build
docker compose ps            # all services should be running
```

| URL | What |
|-----|------|
| `http://localhost:3000` | Customer site — kiosk screen with the QR code |
| `http://localhost:3001` | Admin panel (log in with the values above) |

Then, to exercise table ordering: **Settings** → set Frontend URL to
`http://localhost:3000` → **Tables** → add tables → **Print QR sheet**. Scanning
from a phone needs a LAN address rather than `localhost`, so set Frontend URL to
your machine's IP if you want to test with a real phone.

### Seeing a printed ticket without a printer

Point the print service at any HTTP endpoint that accepts
`POST /print {"text": "..."}`. A throwaway catcher is enough:

```bash
python3 - <<'PY' &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        print(json.loads(body).get('text', ''), flush=True)
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass
HTTPServer(('0.0.0.0', 18080), H).serve_forever()
PY
```

Set **Settings → Printer URL** to `http://host.docker.internal:18080` (Docker
Desktop) and place an order — the ticket text is printed to your terminal.

```bash
cd deploy && docker compose down -v   # tear down, including the database
```

---

## Observability (Dash0 / OpenTelemetry)

ByteOrder is instrumented with OpenTelemetry. For [Dash0](https://github.com/dash0hq/dash0-operator):

```bash
helm upgrade byteorder deploy/helm/byteorder \
  -n byteorder --reuse-values --set dash0.enabled=true
```

For docker-compose, set `OTEL_ENDPOINT` in your `.env`:

```env
OTEL_ENDPOINT=http://your-otel-collector:4317
```

---

## Environment variables reference

| Variable | Services | Description |
|----------|----------|-------------|
| `AUTH_MODE` | all | `cloud` (default) or `self-hosted` |
| `DATABASE_URL` | menu, order, print, admin | Full PostgreSQL DSN |
| `REDIS_URL` | order, print | Redis URL (default `redis://redis:6379`) |
| `ADMIN_USERNAME` | admin | Login username (self-hosted only) |
| `ADMIN_PASSWORD` | admin | Login password (self-hosted only) |
| `JWT_SECRET` | admin | JWT signing secret (self-hosted only) |
| `DEFAULT_KITCHEN_ID` | menu, order, admin | Kitchen ID in self-hosted mode (default `"default"`) |
| `DEFAULT_KITCHEN_SLUG` | menu | Slug seeded into kitchens table on first start (self-hosted only) |
| `CLERK_PUBLISHABLE_KEY` | admin | Clerk publishable key (cloud only) |
| `CLERK_SECRET_KEY` | admin | Clerk secret key (cloud only) |
| `MENU_SERVICE_URL` | admin | Internal URL of menu-service |
| `ORDER_SERVICE_URL` | admin | Internal URL of order-service |
| `OTEL_ENDPOINT` | all | OpenTelemetry collector endpoint (optional) |

---

## Building from source

```bash
cd deploy
docker compose build
```

Multi-arch builds (linux/amd64 + linux/arm64) are handled by GitHub Actions on every push to `main`.

---

## Contributing

Pull requests are welcome. Please open an issue first to discuss significant changes.

## Licence

Copyright © 2026 Matthew Wallace

Released under the [GNU Affero General Public License v3.0](LICENSE).

You are free to use, modify, and self-host this software. If you offer it as a hosted or managed service, the AGPL requires you to make any modifications publicly available under the same licence.
