# Geofence-Based Employee Attendance Management System
## Comprehensive Design Specification

**Version:** 1.0  
**Date:** 2026-03-22  
**Status:** Draft

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture & Core Functionality](#2-system-architecture--core-functionality)
3. [Geofence Configuration](#3-geofence-configuration)
4. [Attendance Logic & Rules](#4-attendance-logic--rules)
5. [UI/UX Design](#5-uiux-design)
6. [Technical Requirements](#6-technical-requirements)
7. [Implementation & Operations](#7-implementation--operations)
8. [Edge Cases & Limitations](#8-edge-cases--limitations)
9. [Appendix — Wireframe Concepts](#9-appendix--wireframe-concepts)

---

## 1. Executive Summary

### Purpose

This document specifies the design for a **local geofence-based employee attendance management system** — a solution that replaces manual clock-in methods with automatic, location-aware presence detection. Employees are clocked in and out as their device enters or exits defined virtual boundaries around workplace locations.

### Business Value

| Benefit | Impact |
|---|---|
| Eliminates manual punch-card or PIN entry | Reduces buddy-punching fraud |
| Automated real-time records | Cuts payroll processing time by ~40% |
| Anomaly alerts | Managers act on missed punches within minutes |
| Audit trail | Satisfies labour-law record-keeping requirements |
| Analytics dashboard | Surfaces attendance trends without manual reporting |

### Key Recommendations (Trade-off Summary)

| Dimension | Recommendation | Trade-off accepted |
|---|---|---|
| Platform | Progressive Web App (PWA) + optional React Native wrapper | Wider reach vs. native-only performance |
| Geofence precision | 50–200 m circular with polygon upgrade option | Simplicity vs. irregular site shapes |
| Processing | Hybrid (real-time event queue + nightly batch reconciliation) | Latency vs. infrastructure cost |
| Auth | JWT + device fingerprint + optional biometric prompt | UX friction vs. security depth |
| Offline | Local queue with server-side reconciliation | Data freshness vs. consistency |

---

## 2. System Architecture & Core Functionality

### 2.1 High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Client Layer                          │
│  ┌─────────────────────┐    ┌─────────────────────────────┐  │
│  │   Employee PWA/App  │    │       Admin Web App         │  │
│  │  (React / RN)       │    │       (React)               │  │
│  └────────┬────────────┘    └──────────────┬──────────────┘  │
└───────────┼───────────────────────────────┼─────────────────┘
            │  HTTPS + WebSocket             │  HTTPS
┌───────────▼────────────────────────────────▼─────────────────┐
│                      API Gateway / Load Balancer             │
└───────────┬──────────────────────────────────────────────────┘
            │
┌───────────▼──────────────────────────────────────────────────┐
│                    Application Services                       │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Auth Service  │  │ Geofence Svc │  │ Attendance Svc   │   │
│  └───────────────┘  └──────────────┘  └──────────────────┘   │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Notification  │  │ Analytics    │  │ HR/Payroll       │   │
│  │ Service       │  │ Service      │  │ Integration Svc  │   │
│  └───────────────┘  └──────────────┘  └──────────────────┘   │
└──────────────────────┬───────────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────────┐
│                    Data Layer                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │  PostgreSQL  │  │    Redis     │  │  Object Storage  │    │
│  │  (primary)   │  │  (events /   │  │  (GPS evidence,  │    │
│  │              │  │   cache)     │  │   exports)       │    │
│  └──────────────┘  └──────────────┘  └──────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Geofencing Technology

#### How Location Tracking Works

1. **Device obtains GPS fix** via the browser Geolocation API (`navigator.geolocation.watchPosition`) or native OS location services.
2. **Client evaluates geofence eligibility locally** using the Haversine formula (circular) or ray-casting algorithm (polygon) against the locally cached geofence list.
3. **Enter/exit events are generated** when the employee crosses a boundary, subject to a configurable dwell time (default 30 s) to suppress transient crossings.
4. **Event payload is sent** to the Attendance Service over HTTPS with GPS coordinates, accuracy radius, device ID, and timestamp.
5. **Server re-validates** the coordinates against the canonical geofence record to prevent client-side tampering.
6. **Attendance record is created or closed** and the employee receives a confirmation notification.

#### Location Sampling Strategy

| Mode | Interval | Accuracy | Battery Impact |
|---|---|---|---|
| Background / idle | Every 5 min | ~100 m | Low |
| Approaching boundary (within 2× radius) | Every 60 s | 50 m | Medium |
| Active — within boundary | Every 2 min | 50 m | Medium |
| Active — event pending confirmation | Every 10 s | 10–20 m | High (short burst) |

Devices shift between modes automatically using a proximity-based trigger.

### 2.3 Database Schema

#### Entity Overview

```
employees ──< shifts ──< attendance_records
    │                         │
    ├──< device_registrations  └──< location_evidence
    │
geofence_locations ──< geofences
    │                    │
    └──< employee_geofence_assignments
```

#### Core Tables

```sql
-- Employee profiles
CREATE TABLE employees (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES organisations(id),
    external_id   TEXT,                     -- HR system ID
    email         TEXT UNIQUE NOT NULL,
    full_name     TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('employee','supervisor','admin','super_admin')),
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','suspended')),
    timezone      TEXT NOT NULL DEFAULT 'UTC',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Geofence definitions (versioned)
CREATE TABLE geofences (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organisations(id),
    location_id     UUID NOT NULL REFERENCES geofence_locations(id),
    version         INTEGER NOT NULL DEFAULT 1,
    name            TEXT NOT NULL,
    shape           TEXT NOT NULL CHECK (shape IN ('circle','polygon')),
    -- Circle: {center_lat, center_lng, radius_meters}
    -- Polygon: GeoJSON geometry string
    geometry        JSONB NOT NULL,
    buffer_meters   INTEGER NOT NULL DEFAULT 10,
    effective_from  TIMESTAMPTZ NOT NULL,
    effective_to    TIMESTAMPTZ,
    created_by      UUID NOT NULL REFERENCES employees(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (location_id, version)
);

-- Physical workplace locations
CREATE TABLE geofence_locations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organisations(id),
    name        TEXT NOT NULL,
    address     TEXT,
    timezone    TEXT NOT NULL DEFAULT 'UTC',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shift templates
CREATE TABLE shifts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organisations(id),
    name            TEXT NOT NULL,
    start_time      TIME NOT NULL,
    end_time        TIME NOT NULL,
    grace_minutes   INTEGER NOT NULL DEFAULT 5,
    early_cutoff    INTEGER NOT NULL DEFAULT 30,  -- minutes before shift start
    late_threshold  INTEGER NOT NULL DEFAULT 15,  -- minutes after shift start
    location_id     UUID REFERENCES geofence_locations(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Attendance records
CREATE TABLE attendance_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     UUID NOT NULL REFERENCES employees(id),
    shift_id        UUID REFERENCES shifts(id),
    geofence_id     UUID REFERENCES geofences(id),
    date            DATE NOT NULL,
    clock_in_at     TIMESTAMPTZ,
    clock_out_at    TIMESTAMPTZ,
    clock_in_method TEXT CHECK (clock_in_method IN ('geofence_auto','manual','admin_override')),
    clock_out_method TEXT CHECK (clock_out_method IN ('geofence_auto','manual','admin_override','shift_end_auto')),
    status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','complete','incomplete','anomaly','approved','rejected')),
    worked_minutes  INTEGER GENERATED ALWAYS AS
                    -- NULL when clock_out_at is NULL (open records); callers must handle NULL in aggregations
                    (EXTRACT(EPOCH FROM (clock_out_at - clock_in_at))/60)::INTEGER STORED,
    overtime_minutes INTEGER,
    flags           TEXT[] DEFAULT '{}',   -- e.g. ['late','early_leave','manual_override']
    note            TEXT,
    approved_by     UUID REFERENCES employees(id),
    approved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (employee_id, date)             -- one record per employee per day; for multi-shift days, remove this constraint and use a separate shift_assignment_id in the PK
);

-- GPS evidence snapshots attached to clock events
CREATE TABLE location_evidence (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attendance_id   UUID NOT NULL REFERENCES attendance_records(id),
    event_type      TEXT NOT NULL CHECK (event_type IN ('clock_in','clock_out','periodic','manual_confirm')),
    latitude        DOUBLE PRECISION NOT NULL,
    longitude       DOUBLE PRECISION NOT NULL,
    accuracy_meters DOUBLE PRECISION,
    altitude_meters DOUBLE PRECISION,
    speed_mps       DOUBLE PRECISION,
    provider        TEXT,               -- 'gps','network','fused'
    captured_at     TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Registered devices (for device binding)
CREATE TABLE device_registrations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     UUID NOT NULL REFERENCES employees(id),
    device_id       TEXT NOT NULL,
    platform        TEXT NOT NULL CHECK (platform IN ('ios','android','web')),
    fingerprint     TEXT NOT NULL,
    push_token      TEXT,
    trusted         BOOLEAN NOT NULL DEFAULT FALSE,
    registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ,
    UNIQUE (employee_id, device_id)
);

-- Audit log for all state-changing operations
CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    actor_id    UUID REFERENCES employees(id),
    action      TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   UUID,
    before_data JSONB,
    after_data  JSONB,
    ip_address  INET,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.4 Real-Time vs. Batch Processing

#### Comparison

| Criterion | Real-Time | Batch | Hybrid (Recommended) |
|---|---|---|---|
| Data freshness | Instant | Hours | Near-instant for events, hourly for aggregates |
| Infrastructure cost | High (always-on queues) | Low | Medium |
| Conflict handling | Complex | Simple | Reconciliation job handles edge cases |
| Manager visibility | Live | Delayed | Live critical events, batched analytics |
| Implementation complexity | High | Low | Medium |

#### Recommended Hybrid Approach

- **Real-time path** (< 2 s): Clock-in/out events → Redis Streams → Attendance Service → PostgreSQL write → push notification.
- **Batch path** (hourly): Reconciliation job scans for open records past shift-end, flags anomalies, computes aggregates, generates daily summary notifications.
- **Nightly batch**: Payroll export, compliance archive, analytics roll-ups.

### 2.5 Offline Behavior

#### Local Queue Architecture

```
Employee Device
┌─────────────────────────────────────────┐
│  Geofence Event Detected                │
│         │                               │
│  ┌──────▼──────────────────────────┐    │
│  │  IndexedDB / SQLite             │    │
│  │  Offline Event Queue            │    │
│  │  { event_type, lat, lng,        │    │
│  │    accuracy, ts, device_sig }   │    │
│  └─────────────────────────────────────┘    │
│         │  (sync when online)           │
└─────────┼───────────────────────────────┘
          │
          ▼  POST /api/attendance/sync
     Reconciliation Service
```

#### Offline Rules

| Scenario | Behaviour |
|---|---|
| Connectivity lost during clock-in | Event queued locally with timestamp |
| Connectivity lost during clock-out | Same — queue with timestamp |
| Device re-connects | Queued events replayed in chronological order |
| Clock-in and clock-out both queued | Server reconciles and creates single record |
| Offline duration > 24 h | Flag record for manager approval |
| Multiple devices send same event | Idempotency key (employee_id + date + event_type) deduplicates |

#### Reconciliation & Conflict Resolution

1. Each queued event carries a client-generated UUID (idempotency key).
2. Server checks for existing record with same key — if present, it skips insertion.
3. If server has a more-recent `clock_out` than the queued one, the server version wins and an audit entry is created.
4. If there is genuine ambiguity (two clock-in events for the same day from different devices), both are preserved as raw events and an anomaly flag is raised for manager review.

---

## 3. Geofence Configuration

### 3.1 Geofence Models

#### Circular Geofence

- Defined by a **centre point** (lat/lng) and a **radius** (meters).
- Boundary check: `haversine_distance(employee_pos, centre) ≤ radius + buffer`.
- Recommended for single-building campuses, warehouses, small offices.

#### Polygon Geofence

- Defined by an ordered list of **vertices** (GeoJSON Polygon).
- Boundary check: Ray-casting point-in-polygon test.
- Recommended for irregularly shaped sites, multi-building campuses, sites straddling roads.

#### Sizing Rules

| Site Type | Minimum Radius | Recommended Radius | Notes |
|---|---|---|---|
| Single office floor | 30 m | 50 m | Accounts for GPS drift |
| Multi-floor building | 50 m | 80 m | Includes adjacent parking |
| Campus (multiple buildings) | 100 m | 150–200 m | Use polygon if shape is irregular |
| Outdoor facility / construction | 50 m | 100 m | High GPS variance expected |
| Retail store / kiosk | 20 m | 40 m | Smallest practical radius |

A **buffer zone** (default 10 m, configurable 0–50 m) is added to the nominal radius/polygon to suppress spurious exit events near the boundary.

### 3.2 Boundary Precision & Edge Cases

| Edge Case | Handling Strategy |
|---|---|
| Employee near entrance but outside | Buffer zone absorbs GPS jitter at threshold |
| Parking lot included in boundary | Admin configures extended radius; policy defines whether parking counts as attendance |
| Building entrance set-back from road | Admin anchors circle on entrance door; polygon recommended for accuracy |
| GPS drift (accuracy > 50 m) | Event flagged with `low_accuracy`; held pending a more accurate sample (timeout 60 s) |
| Underground / basement GPS loss | Falls back to last known valid location; employee prompted to confirm manually |
| Employee on boundary for long period | Dwell timer (30 s by default) prevents oscillation; hysteresis: inner exit boundary = outer entry boundary − 5 m |

### 3.3 Admin Workflows

#### Adding a Geofence

```
1. Admin navigates to "Locations" → "Add Geofence"
2. Map view opens (OpenStreetMap / Google Maps)
3. Admin searches for address or pans to location
4. Selects shape: Circle | Polygon
   • Circle: click centre → drag to set radius
   • Polygon: click vertices → close shape
5. Sets effective_from date (defaults to now)
6. Sets optional effective_to date (for temporary sites)
7. Preview shows affected employees assigned to this location
8. Admin saves → system records versioned geofence (version N+1)
9. Push notification sent to affected employees: "Your work location boundary has been updated."
```

#### Modifying a Geofence

- Modifications always create a **new version** with an updated `effective_from`.
- Previous version is archived (not deleted) and remains queryable for historical attendance.
- Employees currently clocked in are **not** automatically clocked out; the old geofence applies to their open record.

#### Deleting a Geofence

- Soft-delete only: `effective_to` is set to `now()`.
- Hard deletion is blocked if any attendance records reference the geofence.
- If the geofence is the only one assigned to a location, a warning is shown and deletion is blocked until a replacement is created or the location is decommissioned.

#### Versioning Summary

```
geofences table
───────────────────────────────────────────────────────
location_id  version  effective_from  effective_to  name
LOC-001      1        2024-01-01      2025-06-30    HQ Main Office
LOC-001      2        2025-07-01      NULL          HQ Main Office (extended)
```

### 3.4 Overlap Resolution

When multiple geofences match an employee's location (e.g., shared access or nested zones):

| Rule | Priority | Behaviour |
|---|---|---|
| Most specific (smallest area) | 1st | Applied first for clock-in |
| Employee's assigned location | 2nd | Overrides unassigned geofence |
| Most recently created version | 3rd | Tie-breaker |
| Admin-configured priority weight | Override | Explicit numeric priority field on geofence |

If more than one geofence qualifies after all rules:
- The system logs both matches.
- The **primary assigned geofence** is used for the attendance record.
- The secondary match is stored in `location_evidence.flags` for audit purposes.

---

## 4. Attendance Logic & Rules

### 4.1 Clock-In/Out Triggers

#### Automatic Triggers

| Event | Condition | Action |
|---|---|---|
| Device enters geofence | Dwell > 30 s within boundary | Create attendance record, push "You've clocked in" |
| Device exits geofence | Dwell > 30 s outside boundary | Close attendance record, push "You've clocked out" |
| Shift end (auto clock-out) | Record open > 30 min past `shift.end_time` | Auto clock-out with flag `shift_end_auto`; manager notified |

#### Manual Override Triggers

- Employee taps **"Clock In"** / **"Clock Out"** button on dashboard.
- Admin uses attendance review screen to insert or correct a record.

#### User Confirmation

- On auto clock-in: a non-blocking notification appears; employee can **Dismiss** (accept) or **Undo** within 2 minutes.
- On auto clock-out: same mechanism.
- If GPS accuracy < 30 m: confirmation is silent (no prompt needed).
- If GPS accuracy 30–75 m: a subtle banner appears asking the employee to confirm they are at the office.
- If GPS accuracy > 75 m: clock-in is withheld; employee is prompted to "Confirm location manually" with a map pin view.

### 4.2 Anti-Duplicate & Cooldown Logic

| Scenario | Handling |
|---|---|
| Multiple enter events within 5 min | Idempotency window suppresses duplicate clock-in |
| Employee exits briefly (< 10 min) and re-enters | Configurable "re-entry cooldown" — by default treated as continuous (no new record) |
| Accidental clock-out → immediate re-entry | If re-entry within cooldown window (default 10 min), clock-out is cancelled and original record continues |
| Employee tries to clock in twice in one day | Second clock-in blocked; employee sees "You are already clocked in" |
| Different shift / after-hours return | Depends on policy: create new record if more than `gap_threshold` (default 60 min) has elapsed |
| Manager force-clock-in for employee already open | Blocked; manager must close existing record first |

### 4.3 Time-Based Policies

#### Policy Parameters (configurable per shift)

| Parameter | Default | Description |
|---|---|---|
| `grace_minutes` | 5 min | Tolerance after shift start before marking "late" |
| `early_cutoff_minutes` | 30 min | Minimum minutes before shift start to accept clock-in |
| `late_threshold_minutes` | 15 min | After this, record flagged "late" |
| `overtime_threshold_minutes` | 30 min | Minutes beyond shift end before overtime tag is applied |
| `minimum_worked_minutes` | 60 min | Below this threshold, record is flagged for review |
| `auto_clockout_delay_minutes` | 30 min | After shift end, before auto clock-out fires |

#### Status Classification

```
Clock-in time relative to shift.start_time:
  < -early_cutoff    →  REJECTED (too early, held until window opens)
  [-early_cutoff, -grace]  →  ON_TIME (early arrival, accepted)
  [-grace, +grace]   →  ON_TIME
  [+grace, +late_threshold]  →  LATE_MINOR (flagged, no escalation)
  > +late_threshold  →  LATE_MAJOR (flagged, manager notified)
  No clock-in by end of shift  →  ABSENT (manager notified)
```

### 4.4 Notification Flows

#### Employee Notifications

| Trigger | Channel | Message |
|---|---|---|
| Successful clock-in | Push + in-app | "Clocked in at [Location] — [Time]" |
| Successful clock-out | Push + in-app | "Clocked out — worked [X hrs Y min]" |
| Clock-in pending GPS accuracy | In-app banner | "Confirming your location…" |
| Auto clock-out fired | Push | "You were automatically clocked out. Check your record." |
| Missed punch (no clock-in by grace) | Push + email | "You have no clock-in today. Please contact your manager." |
| Anomaly flag raised | In-app | "Your attendance record for [date] needs review." |

#### Manager / Admin Notifications

| Trigger | Channel | Message |
|---|---|---|
| Employee late (major) | Push + email | "[Employee] clocked in 20 min late on [date]." |
| Employee absent | Push + email | "[Employee] has no attendance record for today." |
| Open record past shift end | Email digest | "3 employees have unclosed attendance records." |
| Manual override applied by employee | Email | "[Employee] manually clocked in at [Location] — review required." |
| Anomaly flagged | Dashboard badge + email | "Anomaly: [Employee] — possible duplicate entry." |

---

## 5. UI/UX Design

### 5.1 Design System Tokens

#### Color Palette

```
Primary Gradient:   #6C63FF → #48B2E8  (violet to sky blue)
Secondary Gradient: #FF6B6B → #FFD93D  (coral to amber — used for warnings/CTA)
Success:            #06D6A0
Warning:            #FFD93D
Error:              #EF476F
Background Dark:    #0F0E17
Background Light:   #F5F5F7
Surface:            #1E1E2E  (dark mode card)
Surface Light:      #FFFFFF
Text Primary:       #FFFFFF (dark) / #0F0E17 (light)
Text Secondary:     #A9A9C8
Accent:             #FF6B6B
```

#### Typography

| Token | Family | Weight | Size |
|---|---|---|---|
| `heading-1` | Inter / SF Pro | 700 | 32 px / 2 rem |
| `heading-2` | Inter / SF Pro | 700 | 24 px / 1.5 rem |
| `heading-3` | Inter / SF Pro | 600 | 20 px / 1.25 rem |
| `body` | Inter / SF Pro | 400 | 16 px / 1 rem |
| `body-sm` | Inter / SF Pro | 400 | 14 px / 0.875 rem |
| `label` | Inter / SF Pro | 500 | 12 px / 0.75 rem |
| `mono` | JetBrains Mono | 400 | 14 px / 0.875 rem |

#### Spacing Scale (4 px base)

`4 | 8 | 12 | 16 | 24 | 32 | 48 | 64 | 96 | 128`

#### Motion Tokens

| Token | Value | Usage |
|---|---|---|
| `duration-fast` | 150 ms | Button press feedback |
| `duration-base` | 250 ms | Panel open/close |
| `duration-slow` | 400 ms | Page transitions |
| `duration-xslow` | 600 ms | Onboarding / splash |
| `easing-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | Most transitions |
| `easing-enter` | `cubic-bezier(0, 0, 0.2, 1)` | Elements entering viewport |
| `easing-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Elements leaving viewport |
| `easing-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Button states, micro-interactions |

#### Interaction States

| State | Visual Change |
|---|---|
| Hover | Scale 1.02 + box-shadow elevation lift |
| Active / pressed | Scale 0.97 + shadow collapse |
| Focus | 2 px offset `outline: #6C63FF` |
| Disabled | Opacity 0.38 + no pointer events |
| Loading | Skeleton shimmer or spinner overlay |
| Error | Border turns `#EF476F` + shake animation (150 ms, 3× 4 px) |
| Success | Border turns `#06D6A0` + pulse ripple |

### 5.2 Employee Application

#### Login Page

**Visual concept:**

```
┌──────────────────────────────────────────┐
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
│  ░  Animated gradient background        ░  │
│  ░  (violet → sky blue, slow 8 s loop)  ░  │
│  ░                                      ░  │
│  ░   ┌───────────────────────────────┐  ░  │
│  ░   │  [App Logo — pulse animation] │  ░  │
│  ░   │  AttendNow                    │  ░  │
│  ░   │                               │  ░  │
│  ░   │  Email ____________________   │  ░  │
│  ░   │  Password __________________  │  ░  │
│  ░   │                               │  ░  │
│  ░   │  [Gradient CTA Button]        │  ░  │
│  ░   │  Sign In  →                   │  ░  │
│  ░   │                               │  ░  │
│  ░   │  Don't have an account?       │  ░  │
│  ░   │  Register                     │  ░  │
│  ░   └───────────────────────────────┘  ░  │
│  ░  Floating particles / orbs (subtle)  ░  │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
└──────────────────────────────────────────┘
```

**Animations:**
- Background: slow Ken-Burns gradient shift (8 s ease-in-out infinite).
- Logo: entrance from opacity 0 + translateY(-20 px), 600 ms spring easing.
- Form card: frosted-glass effect (backdrop-filter blur 16 px), slides up 400 ms.
- Input focus: underline expands left-to-right over 250 ms.
- Submit button: ripple effect on press; transforms into a circular spinner on submit; expands back to button on success/error.
- Validation errors: field border pulses red + shake; inline message fades in from below.

#### Registration Page

Same background treatment; form is a **two-step flow**:
- **Step 1:** Personal info (name, email, employee ID).
- **Step 2:** Password creation + consent to location tracking.

Progress indicator: animated segmented bar at top of card, filling left-to-right per step.

Privacy consent block:
```
  ┌─────────────────────────────────────────────┐
  │ 📍 Location Access                          │
  │ This app will track your GPS location while │
  │ you are near registered work locations to   │
  │ log attendance. Location is NOT tracked     │
  │ outside your assigned geofence.             │
  │                                             │
  │  [✓] I agree to location-based clock-in     │
  │  [✓] I understand my data is encrypted      │
  │                                             │
  │  Read full Privacy Policy ↗                 │
  └─────────────────────────────────────────────┘
```

#### Employee Dashboard

```
┌──────────────────────────────────────────────────────┐
│  Header: "Good morning, Alex" + avatar      [≡]      │
│  Subtle gradient top bar                             │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  GEOFENCE STATUS CARD                          │  │
│  │  ● You are IN your work zone                   │  │
│  │    HQ Main Office · 42 m from centre           │  │
│  │    [Pulsing green ring animation]              │  │
│  │                                                │  │
│  │  ┌──────────────────────────────────────────┐  │  │
│  │  │   CLOCK IN                               │  │  │
│  │  │   Large gradient button, 64 px height    │  │  │
│  │  │   Press-and-hold 1 s to prevent accidents│  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌──────────────────────┐  ┌─────────────────────┐   │
│  │ TODAY                │  │ THIS WEEK           │   │
│  │ 0h 0m worked         │  │ 16h 45m             │   │
│  │ Status: Not started  │  │ 4/5 days            │   │
│  └──────────────────────┘  └─────────────────────┘   │
│                                                      │
│  NEXT SHIFT                                          │
│  ┌────────────────────────────────────────────────┐  │
│  │  Mon 24 Mar · 09:00–17:30 · HQ Main Office     │  │
│  │  Countdown: 14 h 22 min                        │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  RECENT ATTENDANCE                                   │
│  ┌────────────────────────────────────────────────┐  │
│  │  Fri 21 Mar   09:02 – 17:28   8h 26m  ✓        │  │
│  │  Thu 20 Mar   09:15 – 17:30   8h 15m  ⚠ Late  │  │
│  │  Wed 19 Mar   08:58 – 17:31   8h 33m  ✓        │  │
│  │  [View all history →]                          │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

**Dashboard Animations:**
- Geofence status card: pulsing ring (color matches status: green inside, yellow approaching, grey outside).
- Clock In button: press-and-hold fills a progress ring; releases and triggers a success burst animation.
- Stat counters: animate from 0 to actual value on first load (400 ms ease-out).
- Attendance row entries: staggered slide-in from right, 50 ms per row.

#### Data Visibility Boundaries

| Data | Employee sees | Manager sees | Admin sees |
|---|---|---|---|
| Own attendance records | ✅ All | ✅ Team only | ✅ All |
| Other employees' records | ❌ | ✅ Team | ✅ All |
| Exact GPS coordinates | ❌ (in/out zone only shown) | ⚠️ On anomaly cases | ✅ All evidence |
| Salary / payroll data | ❌ | ❌ | ✅ |
| Anomaly flags | Own flags only | All team flags | All |

Privacy indicator: a small **shield icon** in the header, tappable to show a plain-language summary of what is and is not tracked.

### 5.3 Admin Application

#### Admin Login Page

Same gradient framework as employee login but with:
- **Elevated visual hierarchy**: deeper background hue (`#0A0A14`), gold accent line at top of the card.
- **"Admin Portal"** label in uppercase letter-spaced text above the logo.
- **Two-factor authentication step** slides in after password validation — animated OTP input with 6 individual digit boxes that auto-focus sequentially.
- **Security badge** at bottom: "🔒 Secured with AES-256 + TLS 1.3."

#### Admin Registration

Requires: name, work email, organisation code, role selection (admin / super-admin). Invitation-only flow — admin receives an email link that pre-fills org code and grants elevated signup permissions.

#### Geofence Management Screen

```
┌──────────────────────────────────────────────────────────────┐
│  Geofences   [+ Add New]                [Search…]  [Filter▾]│
├───────────────────────────────────┬──────────────────────────┤
│                                   │  DETAILS PANEL           │
│  MAP VIEW                         │  Name: HQ Main Office    │
│  ┌─────────────────────────────┐  │  Shape: Circle           │
│  │   [Interactive map]         │  │  Radius: 80 m            │
│  │                             │  │  Assigned: 42 employees  │
│  │   ● HQ (circle, blue)       │  │  Effective: 2024-01-01   │
│  │   ■ Warehouse (polygon, red)│  │  Version: 2              │
│  │                             │  │                          │
│  │  Click a zone to select     │  │  [Edit]  [Delete]        │
│  └─────────────────────────────┘  │                          │
│                                   │  EMPLOYEES IN ZONE NOW   │
│  ZONES LIST                       │  ● Alice Chen  09:02     │
│  ┌─────────────────────────────┐  │  ● Bob Martin  08:55     │
│  │  ● HQ Main Office    42 emp │  │                          │
│  │  ■ Warehouse A       18 emp │  │                          │
│  │  ■ Retail – City Sq   8 emp │  │                          │
│  └─────────────────────────────┘  │                          │
└───────────────────────────────────┴──────────────────────────┘
```

**Animations:** Clicking a zone on the map smoothly pans/zooms to it (400 ms). Drawing mode shows a live preview polygon edge following the cursor. Save triggers a ripple on the map zone and a success toast.

#### Attendance Review Screen

```
┌────────────────────────────────────────────────────────────┐
│  Attendance Review                         [Export ▾]      │
│  [Date range picker]  [Location ▾]  [Status ▾]  [Search…]  │
├──────┬──────────────┬────────────┬────────────┬────────────┤
│ #    │ Employee     │ Date       │ In – Out   │ Status     │
├──────┼──────────────┼────────────┼────────────┼────────────┤
│  1   │ Alice Chen   │ 22 Mar     │ 09:02–17:28│ ✅ OK      │
│  2   │ Bob Martin   │ 22 Mar     │ 09:45–17:30│ ⚠ Late    │
│  3   │ Carol Singh  │ 22 Mar     │ —          │ ❌ Absent  │
│  4   │ Dan Park     │ 22 Mar     │ 08:55–?    │ 🔓 Open    │
├──────┴──────────────┴────────────┴────────────┴────────────┤
│  Analytics Cards                                           │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────┐ │
│  │ Present    │ │ Late       │ │ Absent     │ │ Avg hrs │ │
│  │    38      │ │     4      │ │     2      │ │  8h 12m │ │
│  └────────────┘ └────────────┘ └────────────┘ └─────────┘ │
└────────────────────────────────────────────────────────────┘
```

Anomaly rows highlighted with a subtle amber left-border. Clicking a row expands inline to show GPS evidence map, device info, and an approval/rejection panel.

#### Rule Configuration Screen

Form-based with live preview text that reads the policy back in plain English:

> *"Employees who clock in between 08:30 and 09:05 will be marked ON TIME. Clock-ins after 09:15 are flagged as LATE. Auto clock-out fires at 18:00 if the record is still open."*

#### User Management Screen

Table with inline role toggle, location assignment multi-select, and deactivation toggle. Bulk import via CSV. Each row shows last-seen timestamp and current online/offline status dot.

### 5.4 Responsive Behaviour

| Breakpoint | Layout |
|---|---|
| Mobile (< 640 px) | Single-column, bottom tab navigation, swipe gestures |
| Tablet (640–1024 px) | Two-column cards, side drawer navigation |
| Desktop (> 1024 px) | Three-column layout, persistent sidebar, map + detail panel side-by-side |

Navigation transitions use a shared-element animation on route change (Framer Motion `layoutId`).

### 5.5 Platform Recommendation

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| PWA only | One codebase, instant updates, no app store | Limited background geofencing on iOS | **Primary** |
| React Native + Expo | Near-native geofencing, push notifications | Two builds, app store delays | **Recommended for production** |
| Native iOS + Android | Best battery/geofence APIs | 2× cost, slow iteration | Only if enterprise scale requires it |

**Recommendation:** Ship as a **PWA first** for rapid iteration and web admin, then wrap the employee-facing app in **Expo / React Native** for reliable background geofencing on iOS (which restricts PWA background execution).

---

## 6. Technical Requirements

### 6.1 Platform Strategy & Architecture

**Backend:**
- Runtime: Node.js 20 LTS (or Go 1.22 for high-throughput sites).
- Framework: Fastify (Node) for low-latency event handling.
- API style: REST for CRUD, WebSocket for real-time dashboard updates.
- Message queue: Redis Streams (self-hosted) or AWS SQS.
- Database: PostgreSQL 16 with PostGIS extension for spatial queries.

**Frontend:**
- Employee app: React 18 + Vite + TypeScript, Framer Motion for animations.
- Admin app: React 18 + Vite + TypeScript, React-Leaflet for maps.
- State management: Zustand (lightweight, avoids Redux overhead).
- Offline: service workers (Workbox) + IndexedDB via Dexie.js.

**Infrastructure:**
- Container: Docker + Kubernetes (or simpler: Railway / Fly.io for small deployments).
- CI/CD: GitHub Actions → build, test, deploy.
- CDN: Cloudflare for static assets.
- Maps tile provider: OpenStreetMap (free) or Google Maps (paid; better accuracy).

### 6.2 Integration Points

| System | Integration Method | Direction | Data |
|---|---|---|---|
| HR system (e.g., Workday, BambooHR) | REST API / webhook | Bi-directional | Employee records, shifts, org structure |
| Payroll (e.g., ADP, Gusto) | REST API / nightly CSV | Outbound | Hours worked, overtime, absences |
| Identity provider (SAML / OIDC) | OAuth 2.0 / SAML 2.0 | Inbound (auth) | User identity, role claims |
| Push notifications | FCM (Android) + APNs (iOS) | Outbound | Event alerts |
| Email | SendGrid / SES | Outbound | Digests, alerts, approvals |
| Analytics (optional) | Event stream → data warehouse | Outbound | Aggregated attendance metrics |

### 6.3 Security Controls

#### Authentication

- JWT access tokens (15 min TTL) + refresh tokens (7 days, rotated).
- Refresh tokens stored in `HttpOnly Secure SameSite=Strict` cookies — never localStorage.
- Optional: FIDO2 / WebAuthn biometric authentication on supported devices.

#### RBAC

| Role | Capabilities |
|---|---|
| `employee` | View own records, clock in/out |
| `supervisor` | View and approve team records, override anomalies |
| `admin` | All above + geofence management, rule config, user management |
| `super_admin` | All above + org settings, billing, audit log access |

#### Device Verification

- On first login from a new device, a verification email/SMS code is required.
- Device fingerprint (browser fingerprint or native device ID) is stored and checked on each session.
- Unusual device change triggers a security alert to the employee's email.

#### Data Encryption

| Data | At Rest | In Transit |
|---|---|---|
| Attendance records | AES-256 (PostgreSQL TDE or disk encryption) | TLS 1.3 |
| GPS coordinates | Encrypted at column level (pgcrypto) | TLS 1.3 |
| Refresh tokens | Hashed (Argon2id) in database | TLS 1.3 |
| Exported files | AES-256 + password-protected ZIP | TLS 1.3 |

#### Key Management

- Encryption keys managed via a KMS (AWS KMS, HashiCorp Vault, or Azure Key Vault).
- Application secrets stored in environment variables injected at deploy time (never in source code).
- Annual key rotation with re-encryption of affected data.

#### Audit Logs

- All state-changing API calls are written to `audit_log` table.
- Audit logs are write-once (append-only, no UPDATE/DELETE permission for the app user).
- Exported to immutable object storage monthly.
- Minimum retention: 3 years (configurable by jurisdiction).

### 6.4 Scalability Targets

| Metric | Small (≤ 500 emp) | Medium (500–5k) | Large (5k–50k) |
|---|---|---|---|
| Concurrent location events/s | ~20 | ~200 | ~2,000 |
| Attendance writes/day | ~1,000 | ~10,000 | ~100,000 |
| Dashboard page loads/min | ~100 | ~1,000 | ~10,000 |
| Infrastructure tier | Single VPS + managed DB | 2–3 app nodes + read replica | Kubernetes cluster + sharded DB |

Horizontal scaling is achieved by making the Attendance Service stateless — all state lives in PostgreSQL and Redis.

### 6.5 Mobile Battery & Performance Strategy

| Strategy | Implementation |
|---|---|
| Significant location change API | Use iOS `CLLocationManager` significant-change mode (~500 m granularity) when far from any geofence |
| Geofence region monitoring | Use OS-native geofence APIs (iOS `CLCircularRegion`, Android `GeofencingClient`) for boundary crossing — much lower battery than continuous GPS |
| Sampling rate ramp-up | Switch to continuous GPS only when within 2× the geofence radius |
| Batch uploads | Queue small location pings and flush every 60 s rather than one HTTP call per ping |
| Background app refresh | Schedule at system-determined intervals (iOS) or use WorkManager (Android) |
| Doze mode handling | Android: use high-priority FCM message to wake app for clock-in confirmation |

Estimated battery impact: < 3% additional drain per workday with the above strategy (vs. 15–25% for continuous GPS).

---

## 7. Implementation & Operations

### 7.1 Rollout Plan

#### Phase 0 — Pilot (Weeks 1–4)

- Select 1 location, 20–50 volunteer employees.
- Deploy all components to staging; run parallel with existing attendance method.
- Measure: false positive rate, missed punches, battery impact, employee satisfaction.
- Success criteria: ≥ 95% clock-in accuracy, < 1% false positive rate, NPS ≥ 30.

#### Phase 1 — Controlled Rollout (Weeks 5–10)

- Expand to 3–5 locations, ~200 employees.
- Enable admin features, shift rules, and HR integration (read-only sync first).
- Train supervisors on attendance review and anomaly approval flow.
- Success criteria: All anomaly SLAs met (manager review within 24 h), zero data loss incidents.

#### Phase 2 — Full Deployment (Weeks 11–20)

- Roll out all locations in geographic batches.
- Enable payroll export integration.
- Decommission old attendance system.
- Success criteria: ≥ 99.5% clock-in accuracy, < 0.5% manual override rate, payroll variance ≤ 0.1%.

#### Phase 3 — Optimisation (Ongoing)

- Tune geofence radii based on GPS accuracy data.
- Refine time policies based on HR feedback.
- Add analytics and trend reporting.

### 7.2 Operational Model

| Function | Owner | SLA |
|---|---|---|
| Application monitoring | DevOps (Datadog / Grafana) | Alert on p95 latency > 500 ms |
| Incident response | On-call rotation | P1 response ≤ 15 min |
| User support (L1) | HR admin team (trained) | Response ≤ 4 h |
| User support (L2) | Technical support | Response ≤ 1 business day |
| Geofence updates | HR admins (self-service) | Self-service, no ticket needed |
| Database backup | Automated (daily snapshot + WAL archive) | RPO ≤ 1 h, RTO ≤ 4 h |
| Security patching | DevOps | Critical: ≤ 24 h; High: ≤ 7 days |

### 7.3 Compliance & Audit Trail

| Requirement | Implementation |
|---|---|
| GDPR / data minimisation | GPS coordinates stored only for anomaly evidence; purged after 90 days unless disputed |
| Right to access | Employees can download their own attendance and location evidence via self-service |
| Right to erasure | Supported with legal hold exception for open disputes |
| Audit log retention | 3 years minimum; configurable to 7 years |
| Access logging | All API calls logged with actor, IP, timestamp |
| Labour law record-keeping | Attendance records retained for jurisdiction-specific minimum (typically 3–7 years) |
| Data residency | Configurable per-org: EU / US / APAC hosting zones |

### 7.4 Cost Model

| Component | Small (≤ 500 emp) | Medium (5k emp) | Notes |
|---|---|---|---|
| Cloud infrastructure | $150–$400/mo | $800–$2,000/mo | App servers, managed DB, Redis |
| Maps/geocoding | $0–$50/mo | $100–$500/mo | OSM free; Google Maps charged per load |
| Push notifications | ~$0 (FCM free tier) | ~$50/mo | FCM/APNs; APNs free |
| Email service | $10–$30/mo | $50–$150/mo | SendGrid / SES |
| Object storage (evidence/exports) | $5–$20/mo | $50–$200/mo | S3 / GCS |
| Monitoring | $0–$50/mo | $100–$400/mo | Grafana Cloud free tier; Datadog paid |
| Support & maintenance | $500–$2k/mo | $2k–$10k/mo | Internal or outsourced |
| **Total (est.)** | **$665–$2.5k/mo** | **$3.1k–$13.25k/mo** | Excludes implementation cost |

Implementation (one-time): $30k–$120k depending on team size, existing HR system complexity, and mobile native vs. PWA choice.

---

## 8. Edge Cases & Limitations

### 8.1 Remote Work & Flexible Arrangements

| Scenario | Handling |
|---|---|
| Employee is remote full-time | Assign them to a "Remote" virtual geofence or disable geofencing; use manual check-in |
| Hybrid employee (2 days office, 3 days remote) | Schedule-based policy: geofence required on designated office days; manual or honour-based on remote days |
| Field employee / site visits | Multi-location assignment; clock-in accepted at any assigned geofence |
| Exception request (worked from home on office day) | Employee submits exception via app; manager approves; record updated with `manual` method flag |

### 8.2 Poor GPS Accuracy Fallback

```
GPS accuracy > 75 m?
  └── Yes: Show map to employee for manual pin confirmation
          └── Confirmed: Clock-in with flag 'low_accuracy_manual'
          └── Timeout (60 s): Block clock-in, show error, suggest moving to open area
  └── No (accuracy ≤ 75 m):
        GPS accuracy 30–75 m?
          └── Yes: Auto clock-in with flag 'low_accuracy_auto'; manager can review
          └── No: Normal clock-in, no flag
```

A **confidence score** (0–100) is stored on each location evidence record, computed as:

`confidence = max(0, 100 − (accuracy_meters − 10) × 2)`

Records below confidence 40 are always flagged for review.

### 8.3 Spoofing & Manipulation Detection

| Attack Vector | Detection | Response |
|---|---|---|
| Mock location app (Android) | Check `isMockLocationEnabled` via native API | Block clock-in; log security event; notify admin |
| GPS spoofer hardware | Abnormal speed between location samples (> 200 km/h teleport) | Flag anomaly; require manual confirmation |
| VPN / proxy (web app) | IP geolocation cross-check against reported GPS | Low confidence adjustment; log mismatch |
| Device sharing (multiple users, one device) | Device fingerprint bound to one employee account | Second login attempt alerts security team |
| Edited offline queue timestamp | All events signed with HMAC using device key | Invalid signature → event rejected |
| Repeated manual overrides | Count per employee per week | Alert manager if > 3 manual overrides/week |

Confirmed spoofing triggers a **security review workflow**: event preserved as evidence, clock-in invalidated, manager and HR notified, employee account flagged for review.

### 8.4 Business Continuity Plan

| Failure Scenario | Immediate Response | Recovery Target |
|---|---|---|
| API server down | Employees see "offline mode" banner; events queue locally | RTO: 15 min (auto-restart) |
| Database failure | Read-only cached data served; writes queued | RTO: 60 min (failover to replica) |
| Push notification outage | In-app polling fallback (30 s interval) | Transparent to user |
| GPS unavailable on device | Manual clock-in via app button; flag for review | No system downtime |
| Map provider outage | Cached tile fallback; geofence management paused; attendance unaffected | Non-critical |
| Total cloud outage (region-level) | Automated failover to secondary region (if configured) | RTO: 4 h; RPO: 1 h |
| Cyber incident / breach | Revoke all active tokens; notify affected employees; initiate forensic audit | Within 72 h per GDPR |

**Fallback attendance process** (for extended outages): Employees use a pre-distributed PDF sign-in sheet. HR manually enters records within 48 h of system restoration, using supervisor witness records.

---

## 9. Appendix — Wireframe Concepts

### 9.1 Employee Login — Annotated Wireframe

```
+----------------------------------------------------------+
|                                                          |
|   [ANIMATED GRADIENT BACKGROUND: violet → sky blue,     |
|    8 s slow loop, subtle floating particle orbs]         |
|                                                          |
|          ┌──────────────────────────────────┐            |
|          │  [FROSTED GLASS CARD]            │            |
|          │  backdrop-blur: 16px             │            |
|          │  border: 1px solid rgba(255,     │            |
|          │          255,255,0.15)           │            |
|          │                                  │            |
|          │   ○ [LOGO — pulsing glow ring]   │            |
|          │   AttendNow                      │            |
|          │   "Your attendance, simplified"  │            |
|          │                                  │            |
|          │   ┌──────────────────────────┐   │            |
|          │   │ 📧 Email address          │   │            |
|          │   └──────────────────────────┘   │            |
|          │   ┌──────────────────────────┐   │            |
|          │   │ 🔒 Password          👁  │   │            |
|          │   └──────────────────────────┘   │            |
|          │                                  │            |
|          │   [FORGOT PASSWORD? — link]      │            |
|          │                                  │            |
|          │   ╔══════════════════════════╗   │            |
|          │   ║  Sign In  →  (gradient)  ║   │            |
|          │   ╚══════════════════════════╝   │            |
|          │                                  │            |
|          │   ─────────── or ──────────      │            |
|          │   [Google SSO]  [Apple SSO]      │            |
|          │                                  │            |
|          │   No account? Register →         │            |
|          │                                  │            |
|          │   🔒 TLS 1.3 · AES-256           │            |
|          └──────────────────────────────────┘            |
|                                                          |
+----------------------------------------------------------+

Interaction notes:
  A  Logo pulses every 3 s with a soft glow ring (scale 1→1.08→1, 600 ms)
  B  Input focus: bottom border gradient animates left→right (250 ms)
  C  Sign In button: on tap, ripple effect → circular spinner → success ✓
  D  Error state: field shakes (3× 4 px, 150 ms) + red underline + message fades in
  E  Card entrance: translateY(40px)→0, opacity 0→1, 400 ms spring easing
```

### 9.2 Admin Login — Annotated Wireframe

```
+----------------------------------------------------------+
|                                                          |
|   [DEEP BACKGROUND: #0A0A14 with subtle grid lines +    |
|    slow radial gradient pulse from centre]              |
|                                                          |
|   ═══════════════════════════════════════ GOLD ACCENT   |
|          ┌──────────────────────────────────┐            |
|          │  ADMIN PORTAL                    │            |
|          │  (uppercase, letter-spacing 4px) │            |
|          │                                  │            |
|          │   🛡 [Shield logo — slow rotate] │            |
|          │   AttendNow Admin                │            |
|          │                                  │            |
|          │   ┌──────────────────────────┐   │            |
|          │   │ 📧 Admin email            │   │            |
|          │   └──────────────────────────┘   │            |
|          │   ┌──────────────────────────┐   │            |
|          │   │ 🔒 Password          👁  │   │            |
|          │   └──────────────────────────┘   │            |
|          │                                  │            |
|          │   ╔══════════════════════════╗   │            |
|          │   ║  Sign In  →  (gold CTA)  ║   │            |
|          │   ╚══════════════════════════╝   │            |
|          │                                  │            |
|          │   [2FA step — slides in:]        │            |
|          │   ┌─┐ ┌─┐ ┌─┐  ┌─┐ ┌─┐ ┌─┐    │            |
|          │   │ │ │ │ │ │  │ │ │ │ │ │     │            |
|          │   └─┘ └─┘ └─┘  └─┘ └─┘ └─┘    │            |
|          │   6-digit code (auto-focus)     │            |
|          │                                  │            |
|          └──────────────────────────────────┘            |
|   ══════════════════════════════════════════ GOLD ACCENT |
|                                                          |
+----------------------------------------------------------+

Interaction notes:
  A  Gold accent lines animate in from left edge on page load (500 ms)
  B  Shield logo: 360° rotation on page load (800 ms ease-out), then idle glow
  C  After password submit, form slides left out, OTP boxes slide in from right (350 ms)
  D  Each OTP digit box glows blue on focus, turns green on valid complete entry
  E  Incorrect OTP: all boxes shake simultaneously + turn red (200 ms)
```

### 9.3 Employee Dashboard — Annotated Wireframe

```
+----------------------------------------------------------+
| [GRADIENT TOP BAR: violet→blue, 56 px]                  |
|  ←  Good morning, Alex 👋           [🔔 3]  [avatar]   |
+----------------------------------------------------------+
|                                                          |
|  ┌──────────────────────────────────────────────────┐   |
|  │  LOCATION STATUS                                 │   |
|  │                                                  │   |
|  │   ┌───────────┐   YOU ARE IN YOUR WORK ZONE      │   |
|  │   │  [PULSING │   HQ Main Office                 │   |
|  │   │   GREEN   │   42 m from centre               │   |
|  │   │   RING]   │   GPS accuracy: 18 m ✓           │   |
|  │   └───────────┘                                  │   |
|  │                                                  │   |
|  │   ╔══════════════════════════════════════════╗   │   |
|  │   ║                                          ║   │   |
|  │   ║   HOLD TO CLOCK IN   ████░░░░░░   2s     ║   │   |
|  │   ║   (press-and-hold progress ring)         ║   │   |
|  │   ╚══════════════════════════════════════════╝   │   |
|  └──────────────────────────────────────────────────┘   |
|                                                          |
|  ┌─────────────────────┐  ┌──────────────────────────┐  |
|  │  TODAY              │  │  THIS WEEK               │  |
|  │  0 h 0 m            │  │  16 h 45 m               │  |
|  │  Not started        │  │  4 / 5 days              │  |
|  └─────────────────────┘  └──────────────────────────┘  |
|                                                          |
|  NEXT SHIFT ─────────────────────────────────────────   |
|  ┌──────────────────────────────────────────────────┐   |
|  │  📅  Mon 24 Mar · 09:00 – 17:30                  │   |
|  │  📍  HQ Main Office                              │   |
|  │  ⏱   Starts in 14 h 22 min                      │   |
|  └──────────────────────────────────────────────────┘   |
|                                                          |
|  RECENT HISTORY ─────────────────────────────────────   |
|  ┌──────────────────────────────────────────────────┐   |
|  │  Fri 21 Mar   09:02 → 17:28   8h 26m   ✅         │   |
|  │  Thu 20 Mar   09:15 → 17:30   8h 15m   ⚠ Late    │   |
|  │  Wed 19 Mar   08:58 → 17:31   8h 33m   ✅         │   |
|  │  Tue 18 Mar   09:01 → 17:29   8h 28m   ✅         │   |
|  │                        View full history →        │   |
|  └──────────────────────────────────────────────────┘   |
|                                                          |
|  🛡 Location tracked only within work zone  [Privacy ↗] |
+----------------------------------------------------------+

Interaction notes:
  A  Pulsing ring: green when inside zone, amber within 100 m, grey outside
  B  Hold-to-clock-in: circular progress ring fills clockwise over 2 s
     On release before completion: ring resets (spring-back animation)
     On completion: success burst (particle explosion) + card turns green briefly
  C  Stat counters: count up from 0 on page load (400 ms ease-out)
  D  History rows: stagger in from right, 50 ms per row, opacity 0→1
  E  Late row: amber left border, ⚠ icon pulses once on load
  F  Bottom privacy bar: subtle, non-intrusive; links to data policy
```

---

*End of Specification Document*

*For questions or contributions, open an issue or pull request in the project repository.*
