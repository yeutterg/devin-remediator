import { z } from "zod";

const SessionStatusApi = z.enum([
  "running",
  "blocked",
  "completed",
  "stopped",
  "finished",
  "expired",
  "suspended",
]);

const CreateSessionResponse = z.object({
  session_id: z.string(),
  url: z.string().optional(),
});

const GetSessionResponse = z.object({
  session_id: z.string(),
  status: SessionStatusApi.or(z.string()),
  status_enum: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  is_archived: z.boolean().optional(),
  acus_consumed: z.number().optional(),
  structured_output: z.record(z.string(), z.unknown()).optional().nullable(),
  pull_request: z
    .object({ url: z.string().optional() })
    .optional()
    .nullable(),
  pull_requests: z
    .array(
      z.object({
        url: z.string().optional(),
        title: z.string().optional(),
        status: z.string().optional(),
      }),
    )
    .optional()
    .nullable(),
});

export type GetSessionData = z.infer<typeof GetSessionResponse>;

const PlaybookResponse = z.object({
  playbook_id: z.string(),
  title: z.string(),
  body: z.string(),
  macro: z.string().nullable().optional(),
  updated_at: z.number().optional(),
});
export type PlaybookResponseT = z.infer<typeof PlaybookResponse>;

const ListPlaybooksResponse = z.object({
  items: z.array(PlaybookResponse).optional(),
  playbooks: z.array(PlaybookResponse).optional(),
});

const SelfResponse = z.object({
  user_id: z.string().optional(),
  email: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  service_user: z.boolean().optional(),
});
export type SelfResponseT = z.infer<typeof SelfResponse>;

export type CreateSessionArgs = {
  prompt: string;
  tags?: string[];
  playbookId?: string;
  createAsUserId?: string;
  structuredOutputSchema?: Record<string, unknown>;
  title?: string;
  repos?: string[];
  maxAcuLimit?: number;
};

export class DevinClient {
  constructor(
    private readonly apiKey: string,
    private readonly orgId: string,
    private readonly base: string = "https://api.devin.ai/v3",
  ) {}

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "devin-remediator/0.2.0",
    };
  }

  async createSession(args: CreateSessionArgs): Promise<{ sessionId: string; url: string }> {
    const body: Record<string, unknown> = { prompt: args.prompt };
    if (args.tags?.length) body.tags = args.tags;
    if (args.playbookId) body.playbook_id = args.playbookId;
    if (args.createAsUserId) body.create_as_user_id = args.createAsUserId;
    if (args.structuredOutputSchema) body.structured_output_schema = args.structuredOutputSchema;
    if (args.title) body.title = args.title;
    if (args.repos?.length) body.repos = args.repos;
    if (typeof args.maxAcuLimit === "number") body.max_acu_limit = args.maxAcuLimit;
    const res = await fetch(`${this.base}/organizations/${this.orgId}/sessions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Devin createSession ${res.status}: ${await res.text()}`);
    const parsed = CreateSessionResponse.parse(await res.json());
    const id = parsed.session_id.startsWith("devin-") ? parsed.session_id : `devin-${parsed.session_id}`;
    const url = parsed.url ?? `https://app.devin.ai/sessions/${id.replace(/^devin-/, "")}`;
    return { sessionId: id, url };
  }

  async getSession(id: string): Promise<GetSessionData> {
    const devinId = id.startsWith("devin-") ? id : `devin-${id}`;
    const res = await fetch(
      `${this.base}/organizations/${this.orgId}/sessions/${devinId}`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`Devin getSession ${res.status}: ${await res.text()}`);
    return GetSessionResponse.parse(await res.json());
  }

  async sendMessage(id: string, message: string): Promise<void> {
    const devinId = id.startsWith("devin-") ? id : `devin-${id}`;
    const res = await fetch(
      `${this.base}/organizations/${this.orgId}/sessions/${devinId}/messages`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ message }),
      },
    );
    if (!res.ok) throw new Error(`Devin sendMessage ${res.status}: ${await res.text()}`);
  }

  async archiveSession(id: string): Promise<void> {
    const devinId = id.startsWith("devin-") ? id : `devin-${id}`;
    // DELETE with archive=true both frees the concurrent-session slot AND preserves the session
    // for audit. Using POST /archive alone leaves the session counted toward the cap.
    const res = await fetch(
      `${this.base}/organizations/${this.orgId}/sessions/${devinId}?archive=true`,
      { method: "DELETE", headers: this.headers() },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Devin archiveSession ${res.status}: ${await res.text()}`);
    }
  }

  async getSelf(): Promise<SelfResponseT> {
    const res = await fetch(`${this.base}/self`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Devin getSelf ${res.status}: ${await res.text()}`);
    return SelfResponse.parse(await res.json());
  }

  async listPlaybooks(): Promise<PlaybookResponseT[]> {
    const res = await fetch(
      `${this.base}/organizations/${this.orgId}/playbooks`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`Devin listPlaybooks ${res.status}: ${await res.text()}`);
    const raw = await res.json();
    if (Array.isArray(raw)) return raw.map((x) => PlaybookResponse.parse(x));
    const parsed = ListPlaybooksResponse.parse(raw);
    return parsed.items ?? parsed.playbooks ?? [];
  }

  async createPlaybook(args: { title: string; body: string; macro?: string }): Promise<PlaybookResponseT> {
    const res = await fetch(
      `${this.base}/organizations/${this.orgId}/playbooks`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(args),
      },
    );
    if (!res.ok) throw new Error(`Devin createPlaybook ${res.status}: ${await res.text()}`);
    return PlaybookResponse.parse(await res.json());
  }

  async updatePlaybook(
    playbookId: string,
    args: { title?: string; body?: string; macro?: string },
  ): Promise<PlaybookResponseT> {
    const res = await fetch(
      `${this.base}/organizations/${this.orgId}/playbooks/${playbookId}`,
      {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify(args),
      },
    );
    if (!res.ok) throw new Error(`Devin updatePlaybook ${res.status}: ${await res.text()}`);
    return PlaybookResponse.parse(await res.json());
  }
}

export function normalizeStatus(api: string): "running" | "blocked" | "completed" | "stopped" {
  const s = api.toLowerCase();
  if (["completed", "finished"].includes(s)) return "completed";
  if (["stopped", "expired", "terminated"].includes(s)) return "stopped";
  if (["blocked", "suspended", "waiting"].includes(s)) return "blocked";
  return "running";
}
