import type { ToolDefinition } from "../../schemas.js";
import type { ToolHandler } from "../registry.js";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── macOS Calendar Access ─────────────────────────────────────
// Uses Swift/EventKit via a compiled helper binary for fast,
// native calendar access on macOS.

const HELPER_DIR = join(homedir(), ".beercan");
const HELPER_BIN = join(HELPER_DIR, "calendar-helper");

// ── List Calendars ────────────────────────────────────────────

export const calendarListDefinition: ToolDefinition = {
  name: "calendar_list",
  description:
    "List all calendar accounts and their calendars on macOS. Returns calendar names, source accounts, writable status, and type.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export const calendarListHandler: ToolHandler = async () => {
  assertMacOS();
  return runHelper("list", {});
};

// ── Get Calendar Events ───────────────────────────────────────

export const calendarGetEventsDefinition: ToolDefinition = {
  name: "calendar_get_events",
  description:
    "Get calendar events within a date range. Returns event details including title, start/end times, location, notes, and calendar name. Dates should be in YYYY-MM-DD format.",
  inputSchema: {
    type: "object",
    properties: {
      start_date: {
        type: "string",
        description: "Start date in YYYY-MM-DD format (defaults to today)",
      },
      end_date: {
        type: "string",
        description: "End date in YYYY-MM-DD format (defaults to 7 days from start)",
      },
      calendar_name: {
        type: "string",
        description: "Filter to a specific calendar name (optional, returns all if omitted)",
      },
    },
    required: [],
  },
};

export const calendarGetEventsHandler: ToolHandler = async (input) => {
  assertMacOS();
  const startDate = (input.start_date as string) || new Date().toISOString().slice(0, 10);
  const endDate =
    (input.end_date as string) ||
    new Date(new Date(startDate).getTime() + 7 * 86400000).toISOString().slice(0, 10);
  return runHelper("events", {
    start: startDate,
    end: endDate,
    ...(input.calendar_name ? { calendar: input.calendar_name as string } : {}),
  });
};

// ── Create Calendar Event ─────────────────────────────────────

export const calendarCreateEventDefinition: ToolDefinition = {
  name: "calendar_create_event",
  description:
    "Create a new calendar event on macOS. Specify title, start/end times, and optionally location, notes, calendar name, and all-day flag.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Event title/summary" },
      start_date: {
        type: "string",
        description: "Start date/time in ISO 8601 format (e.g., 2026-03-21T14:00:00)",
      },
      end_date: {
        type: "string",
        description: "End date/time in ISO 8601 format (e.g., 2026-03-21T15:00:00)",
      },
      calendar_name: {
        type: "string",
        description: "Calendar name to add the event to (uses default calendar if omitted)",
      },
      location: { type: "string", description: "Event location (optional)" },
      notes: { type: "string", description: "Event notes/description (optional)" },
      all_day: { type: "boolean", description: "Whether this is an all-day event (default false)" },
    },
    required: ["title", "start_date", "end_date"],
  },
};

export const calendarCreateEventHandler: ToolHandler = async (input) => {
  assertMacOS();
  const args: Record<string, unknown> = {
    title: input.title,
    start: input.start_date,
    end: input.end_date,
  };
  if (input.calendar_name) args.calendar = input.calendar_name;
  if (input.location) args.location = input.location;
  if (input.notes) args.notes = input.notes;
  if (input.all_day) args.allDay = true;
  return runHelper("create", args);
};

// ── Search Calendar Events ────────────────────────────────────

export const calendarSearchDefinition: ToolDefinition = {
  name: "calendar_search",
  description:
    "Search calendar events by keyword in title/notes. Searches within a date range (default: past 30 days to 30 days ahead).",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search keyword to match against event titles and notes" },
      start_date: {
        type: "string",
        description: "Start of search range in YYYY-MM-DD format (default: 30 days ago)",
      },
      end_date: {
        type: "string",
        description: "End of search range in YYYY-MM-DD format (default: 30 days from now)",
      },
    },
    required: ["query"],
  },
};

export const calendarSearchHandler: ToolHandler = async (input) => {
  assertMacOS();
  const now = Date.now();
  const startDate = (input.start_date as string) || new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  const endDate = (input.end_date as string) || new Date(now + 30 * 86400000).toISOString().slice(0, 10);
  return runHelper("search", {
    query: input.query,
    start: startDate,
    end: endDate,
  });
};

// ── Helpers ───────────────────────────────────────────────────

function assertMacOS(): void {
  if (process.platform !== "darwin") {
    throw new Error("Calendar tools are only available on macOS");
  }
}

async function ensureHelper(): Promise<string> {
  if (existsSync(HELPER_BIN)) return HELPER_BIN;

  const { execFileSync } = await import("child_process");
  const { writeFileSync, mkdirSync } = await import("fs");

  mkdirSync(HELPER_DIR, { recursive: true });

  const swiftSrc = join(HELPER_DIR, "calendar-helper.swift");
  writeFileSync(swiftSrc, SWIFT_SOURCE);

  try {
    execFileSync("swiftc", ["-O", "-o", HELPER_BIN, swiftSrc], {
      timeout: 60000,
      encoding: "utf-8",
    });
  } catch (err: any) {
    throw new Error(`Failed to compile calendar helper: ${err.stderr || err.message}`);
  }

  return HELPER_BIN;
}

async function runHelper(command: string, args: Record<string, unknown>): Promise<string> {
  const bin = await ensureHelper();
  const { execFileSync } = await import("child_process");

  const payload = JSON.stringify({ command, ...args });

  try {
    const result = execFileSync(bin, [], {
      input: payload,
      timeout: 30000,
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return result.trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString() || "";
    if (stderr.includes("denied") || stderr.includes("not authorized")) {
      throw new Error(
        "Calendar access denied. Grant access in System Settings > Privacy & Security > Calendars.",
      );
    }
    throw new Error(`Calendar operation failed: ${stderr || err.message}`);
  }
}

// ── Swift Helper Source ───────────────────────────────────────

const SWIFT_SOURCE = `
import EventKit
import Foundation

struct Request: Decodable {
    let command: String
    let start: String?
    let end: String?
    let calendar: String?
    let query: String?
    let title: String?
    let location: String?
    let notes: String?
    let allDay: Bool?
}

let store = EKEventStore()
let sem = DispatchSemaphore(value: 0)
var accessGranted = false

store.requestFullAccessToEvents { granted, error in
    accessGranted = granted
    sem.signal()
}
sem.wait()

guard accessGranted else {
    print("{\\"error\\":\\"Calendar access denied. Grant access in System Settings > Privacy & Security > Calendars.\\"}")
    exit(1)
}

let inputData = FileHandle.standardInput.readDataToEndOfFile()
guard let request = try? JSONDecoder().decode(Request.self, from: inputData) else {
    print("{\\"error\\":\\"Invalid input\\"}")
    exit(1)
}

let df = DateFormatter()
df.dateFormat = "yyyy-MM-dd"
let iso = ISO8601DateFormatter()
// Also parse full ISO datetime
let isoFull = ISO8601DateFormatter()
isoFull.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

func parseDate(_ s: String) -> Date? {
    return df.date(from: s) ?? iso.date(from: s) ?? isoFull.date(from: s) ?? {
        // Try parsing without timezone (local time)
        let lf = DateFormatter()
        lf.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        lf.timeZone = TimeZone.current
        return lf.date(from: s)
    }()
}

func eventToDict(_ ev: EKEvent) -> [String: Any] {
    return [
        "title": ev.title ?? "",
        "start": iso.string(from: ev.startDate),
        "end": iso.string(from: ev.endDate),
        "location": ev.location ?? "",
        "notes": (ev.notes ?? "").prefix(500),
        "calendar": ev.calendar.title,
        "source": ev.calendar.source.title,
        "allDay": ev.isAllDay,
        "uid": ev.eventIdentifier ?? ""
    ]
}

func output(_ obj: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

switch request.command {
case "list":
    let cals = store.calendars(for: .event)
    var results: [[String: Any]] = []
    for cal in cals {
        results.append([
            "name": cal.title,
            "source": cal.source.title,
            "writable": cal.allowsContentModifications,
            "type": cal.type.rawValue
        ])
    }
    output(results)

case "events":
    guard let startStr = request.start, let endStr = request.end,
          let startDate = parseDate(startStr),
          let endDate = parseDate(endStr + "T23:59:59") ?? parseDate(endStr) else {
        print("{\\"error\\":\\"Invalid dates\\"}")
        exit(1)
    }
    var calendars: [EKCalendar]? = nil
    if let calName = request.calendar {
        calendars = store.calendars(for: .event).filter { $0.title == calName }
    }
    let pred = store.predicateForEvents(withStart: startDate, end: endDate, calendars: calendars)
    let events = store.events(matching: pred)
    var results: [[String: Any]] = []
    for ev in events {
        results.append(eventToDict(ev))
    }
    output(results)

case "search":
    guard let q = request.query?.lowercased() else {
        print("{\\"error\\":\\"Missing query\\"}")
        exit(1)
    }
    let startDate = request.start.flatMap { parseDate($0) } ?? Date().addingTimeInterval(-30*86400)
    let endDate = request.end.flatMap { parseDate($0 + "T23:59:59") ?? parseDate($0) } ?? Date().addingTimeInterval(30*86400)
    let pred = store.predicateForEvents(withStart: startDate, end: endDate, calendars: nil)
    let events = store.events(matching: pred)
    var results: [[String: Any]] = []
    for ev in events {
        let title = (ev.title ?? "").lowercased()
        let notes = (ev.notes ?? "").lowercased()
        if title.contains(q) || notes.contains(q) {
            results.append(eventToDict(ev))
        }
    }
    output(results)

case "create":
    guard let title = request.title,
          let startStr = request.start, let endStr = request.end,
          let startDate = parseDate(startStr),
          let endDate = parseDate(endStr) else {
        print("{\\"error\\":\\"Missing required fields: title, start, end\\"}")
        exit(1)
    }

    let event = EKEvent(eventStore: store)
    event.title = title
    event.startDate = startDate
    event.endDate = endDate
    event.isAllDay = request.allDay ?? false
    if let loc = request.location { event.location = loc }
    if let n = request.notes { event.notes = n }

    if let calName = request.calendar {
        if let cal = store.calendars(for: .event).first(where: { $0.title == calName && $0.allowsContentModifications }) {
            event.calendar = cal
        } else {
            print("{\\"error\\":\\"Calendar not found or not writable: \\(calName)\\"}")
            exit(1)
        }
    } else {
        event.calendar = store.defaultCalendarForNewEvents
    }

    do {
        try store.save(event, span: .thisEvent)
        let result: [String: Any] = [
            "success": true,
            "uid": event.eventIdentifier ?? "",
            "title": event.title ?? "",
            "start": iso.string(from: event.startDate),
            "end": iso.string(from: event.endDate),
            "calendar": event.calendar.title
        ]
        output(result)
    } catch {
        print("{\\"error\\":\\"Failed to create event: \\(error.localizedDescription)\\"}")
        exit(1)
    }

default:
    print("{\\"error\\":\\"Unknown command: \\(request.command)\\"}")
    exit(1)
}
`;
