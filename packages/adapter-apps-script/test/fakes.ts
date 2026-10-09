// Minimal in-memory fakes for the slice of each Google service our adapters
// actually call. Not full reimplementations of the real APIs.

export function makeFakeProperties(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const properties = {
    getProperty: (key: string) => store.get(key) ?? null,
    setProperty: (key: string, value: string) => {
      store.set(key, value);
      return properties;
    },
  };
  return properties;
}

export function makeFakeScriptApp(handlerFunctions: string[] = []) {
  const triggers = handlerFunctions.map((handlerFunction) => ({
    getHandlerFunction: () => handlerFunction,
  }));
  return {
    getProjectTriggers: () => triggers,
  };
}

export function makeFakeLock() {
  let locked = false;
  return {
    tryLock: (_timeoutMs: number) => {
      if (locked) return false;
      locked = true;
      return true;
    },
    releaseLock: () => {
      locked = false;
    },
  };
}

interface FakeGmailMessage {
  id: string;
  date: Date;
  from: string;
  subject: string;
  body: string;
  threadId: string;
}

export class FakeGmailThread {
  constructor(
    public messages: FakeGmailMessage[],
    public labels: Set<string> = new Set(),
  ) {}

  getMessages() {
    return this.messages.map((m) => ({
      getId: () => m.id,
      getDate: () => m.date,
      getFrom: () => m.from,
      getSubject: () => m.subject,
      getPlainBody: () => m.body,
      getThread: () => this,
    }));
  }

  addLabel(label: { getName(): string }) {
    this.labels.add(label.getName());
  }

  hasLabel(name: string) {
    return this.labels.has(name);
  }
}

export function makeFakeGmailApp(threads: FakeGmailThread[]) {
  const labels = new Map<string, { getName(): string }>();
  const messagesById = new Map<string, ReturnType<FakeGmailThread['getMessages']>[number]>();
  for (const thread of threads) {
    for (const message of thread.getMessages()) {
      messagesById.set(message.getId(), message);
    }
  }

  return {
    search: (query: string) => {
      const excludeLabel = /-label:(\S+)/.exec(query)?.[1];
      return threads.filter((thread) => !excludeLabel || !thread.hasLabel(excludeLabel));
    },
    getUserLabelByName: (name: string) => (labels.has(name) ? labels.get(name)! : null),
    createLabel: (name: string) => {
      const label = { getName: () => name };
      labels.set(name, label);
      return label;
    },
    getMessageById: (id: string) => {
      const message = messagesById.get(id);
      if (!message) throw new Error(`No fake message with id ${id}`);
      return message;
    },
  };
}

export interface FakeCalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  location: string;
  description: string;
  tags: Record<string, string>;
  color: string | null;
  reminders: number[];
  deleted: boolean;
}

export function makeFakeCalendarEvent(overrides: Partial<FakeCalendarEvent> = {}): FakeCalendarEvent {
  return {
    id: 'fake-event-id',
    title: '',
    start: new Date(),
    end: new Date(),
    location: '',
    description: '',
    tags: {},
    color: null,
    reminders: [],
    deleted: false,
    ...overrides,
  };
}

function wrapCalendarEvent(event: FakeCalendarEvent) {
  const wrapped = {
    getId: () => event.id,
    setTitle: (title: string) => {
      event.title = title;
      return wrapped;
    },
    setTime: (start: Date, end: Date) => {
      event.start = start;
      event.end = end;
      return wrapped;
    },
    setLocation: (location: string) => {
      event.location = location;
      return wrapped;
    },
    setDescription: (description: string) => {
      event.description = description;
      return wrapped;
    },
    setTag: (key: string, value: string) => {
      event.tags[key] = value;
      return wrapped;
    },
    getTag: (key: string) => event.tags[key] ?? null,
    setColor: (color: string) => {
      event.color = color;
      return wrapped;
    },
    removeAllReminders: () => {
      event.reminders = [];
      return wrapped;
    },
    addPopupReminder: (minutes: number) => {
      event.reminders.push(minutes);
      return wrapped;
    },
    deleteEvent: () => {
      event.deleted = true;
    },
  };
  return wrapped;
}

export function makeFakeCalendarApp(events: FakeCalendarEvent[] = [], name = 'Turo Sync Test') {
  let nextId = events.length + 1;

  const calendar = {
    getEventsCalls: 0,
    getEventByIdCalls: 0,
    getName: () => name,
    createEvent: (title: string, start: Date, end: Date, options: { location?: string; description?: string }) => {
      const event = makeFakeCalendarEvent({
        id: `event-${nextId++}`,
        title,
        start,
        end,
        location: options.location ?? '',
        description: options.description ?? '',
      });
      events.push(event);
      return wrapCalendarEvent(event);
    },
    getEvents: (rangeStart: Date, rangeEnd: Date) => {
      calendar.getEventsCalls++;
      return events
        .filter((e) => !e.deleted && e.start < rangeEnd && e.end > rangeStart)
        .map((e) => wrapCalendarEvent(e));
    },
    getEventById: (id: string) => {
      calendar.getEventByIdCalls++;
      const event = events.find((e) => e.id === id && !e.deleted);
      return event ? wrapCalendarEvent(event) : null;
    },
  };

  return {
    getCalendarById: (id: string) => (id === 'missing-calendar' ? null : calendar),
    EventColor: {
      PALE_BLUE: '1',
      PALE_GREEN: '2',
      MAUVE: '3',
      PALE_RED: '4',
      YELLOW: '5',
      ORANGE: '6',
      CYAN: '7',
      GRAY: '8',
      BLUE: '9',
      GREEN: '10',
      RED: '11',
    },
  };
}

type SheetRow = (string | number)[];

export class FakeSheet {
  rows: SheetRow[] = [];

  constructor(public name: string) {}

  getLastRow() {
    return this.rows.length;
  }

  appendRow(row: SheetRow) {
    this.rows.push([...row]);
  }

  getDataRange() {
    return { getValues: () => this.rows.map((row) => [...row]) };
  }

  // 1-based row/column indices, matching the real Sheets API.
  getRange(row: number, col: number, numRows: number, numCols: number) {
    return {
      setValues: (values: SheetRow[]) => {
        for (let r = 0; r < numRows; r++) {
          for (let c = 0; c < numCols; c++) {
            this.rows[row - 1 + r][col - 1 + c] = values[r][c];
          }
        }
      },
    };
  }
}

export class FakeSpreadsheet {
  private sheets = new Map<string, FakeSheet>();
  private id: string;

  constructor(id: string, sheetNames: string[] = ['Sheet1']) {
    this.id = id;
    for (const name of sheetNames) this.sheets.set(name, new FakeSheet(name));
  }

  getId() {
    return this.id;
  }

  getSheetByName(name: string) {
    return this.sheets.get(name) ?? null;
  }

  insertSheet(name: string) {
    const sheet = new FakeSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }

  getSheets() {
    return [...this.sheets.values()];
  }

  deleteSheet(sheet: FakeSheet) {
    this.sheets.delete(sheet.name);
  }
}

export function makeFakeSpreadsheetApp() {
  const byId = new Map<string, FakeSpreadsheet>();
  let nextId = 1;

  return {
    create: (_name: string) => {
      const spreadsheet = new FakeSpreadsheet(`spreadsheet-${nextId++}`);
      byId.set(spreadsheet.getId(), spreadsheet);
      return spreadsheet;
    },
    openById: (id: string) => {
      const spreadsheet = byId.get(id);
      if (!spreadsheet) throw new Error(`No fake spreadsheet with id ${id}`);
      return spreadsheet;
    },
    _register: (spreadsheet: FakeSpreadsheet) => byId.set(spreadsheet.getId(), spreadsheet),
  };
}
