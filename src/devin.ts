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
  structured_output: z.record(z.string(), z.unknown()).optional().nullable(),
  pull_request: z
    .object({ url: z.string().optional() })
    .optional()
    .nullable(),
});

export type CreateSessionArgs = {
  prompt: string;
  tags?: string[];
  playbookId?: string;
  createAsUserId?: string;
  structuredOutputSchema?: Record<string, unknown>;
  title?: string;
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
      "User-Agent": "devin-remediator/0.1.0",
    };
  }

  async createSession(args: CreateSessionArgs): Promise<{ sessionId: string; url: string }> {
    const body: Record<string, unknown> = { prompt: args.prompt };
    if (args.tags?.length) body.tags = args.tags;
    if (args.playbookId) body.playbook_id = args.playbookId;
    if (args.createAsUserId) body.create_as_user_id = args.createAsUserId;
    if (args.structuredOutputSchema) body.structured_output_schema = args.structuredOutputSchema;
    if (args.title) body.title = args.title;
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

  async getSession(id: string) {
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
}

export function normalizeStatus(api: string): "running" | "blocked" | "completed" | "stopped" {
  const s = api.toLowerCase();
  if (["completed", "finished"].includes(s)) return "completed";
  if (["stopped", "expired", "terminated"].includes(s)) return "stopped";
  if (["blocked", "suspended", "waiting"].includes(s)) return "blocked";
  return "running";
}
