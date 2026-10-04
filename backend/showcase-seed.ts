import { platformSchema, schemas } from "./schema.ts";
import { json, type Query } from "./db.ts";
import {
  SHOWCASE_TENANT as t,
  SHOWCASE_OA as oa,
  SHOWCASE_USER as u,
} from "./showcase.ts";
export function showcaseSeed(authDDL: string[], at = new Date()) {
  const stamp = at.toISOString(),
    past = new Date(+at - 86400000).toISOString(),
    future = new Date(+at + 86400000).toISOString(),
    expires = new Date(+at + 365 * 86400000).toISOString();
  const sets: Record<"platform" | "common" | "harness" | "studio", Query[]> = {
    platform: [...platformSchema, ...authDDL].map((sql) => ({ sql })),
    common: schemas.common.map((sql) => ({ sql })),
    harness: schemas.harness.map((sql) => ({ sql })),
    studio: schemas.tsunagu.map((sql) => ({ sql })),
  };
  const add = (
    db: keyof typeof sets,
    table: string,
    row: Record<string, string | number | null>,
  ) =>
    sets[db].push({
      sql: `INSERT OR IGNORE INTO "${table}" (${Object.keys(row)
        .map((x) => '"' + x + '"')
        .join(",")}) VALUES (${Object.keys(row)
        .map(() => "?")
        .join(",")})`,
      params: Object.values(row),
    });
  add("platform", "user", {
    id: u,
    name: "デモ担当者",
    email: "demo@example.com",
    emailVerified: 1,
    createdAt: +at,
    updatedAt: +at,
  });
  add("platform", "ops_assignments", {
    email: "demo@example.com",
    role: "ops_owner",
    state: "active",
  });
  add("platform", "tenants", {
    id: t,
    name: "つなぐ不動産（架空の見学企業）",
    industry: "不動産",
    unit: "company",
    method: "agency",
    product: "harness",
    state: "active",
    plan_name: "画面見学用サンプル",
    monthly_fee: 30000,
    settings: json({ retentionDays: null, shareTeam: true }),
    created_at: past,
  });
  add("platform", "memberships", {
    tenant_id: t,
    user_id: u,
    roles: json(["org_owner", "sys_admin", "sales", "team_admin", "billing"]),
    teams: json(["showcase-team"]),
  });
  add("platform", "tenant_business", {
    tenant_id: t,
    industry: "estate",
    topics: json(["住宅ローン", "金利", "住まい"]),
    updated_by: u,
    updated_at: stamp,
  });
  add("platform", "accounts", {
    id: oa,
    tenant_id: t,
    name: "つなぐ不動産｜顧客用LINE（見本）",
    kind: "company",
    origin: "existing",
    owner_user_id: u,
    operators: json([u]),
    state: "ready",
    webhook_mode: "harness",
    webhook_verified_at: past,
    calibration_ready: 1,
    preview_ready: 1,
    primary_calibration_user_id: u,
    created_at: past,
  });
  for (const purpose of ["common", "harness", "tsunagu"])
    add("platform", "databases", {
      id: "showcase-" + purpose,
      tenant_id: t,
      oa_id: purpose === "common" ? "" : oa,
      purpose,
      physical_id: "isolated-showcase-" + purpose,
      state: "ready",
      schema_version: 1,
    });
  add("platform", "tenant_runtimes", {
    tenant_id: t,
    url: "https://tsunagu-gs-showcase.shimoryo.workers.dev",
    version: 1,
    state: "ready",
  });
  add("platform", "invitations", {
    id: "showcase-invite",
    tenant_id: t,
    email: "demo@example.com",
    roles: json(["org_owner", "sales"]),
    expires_at: expires,
    accepted_by: u,
    accepted_at: past,
    created_by: u,
    created_at: past,
  });
  add("platform", "jobs", {
    id: "showcase-job",
    tenant_id: t,
    oa_id: oa,
    kind: "provision",
    state: "completed",
    dedupe_key: "showcase-only",
    steps: json([{ name: "database", state: "completed" }]),
    attempts: 1,
    created_by: u,
    created_at: past,
    updated_at: stamp,
  });
  add("platform", "audit", {
    id: "showcase-audit",
    tenant_id: t,
    actor_id: u,
    action: "tenant.created",
    target: t,
    metadata: json({ example: true }),
    at: past,
  });
  add("platform", "usage_events", {
    id: "showcase-usage",
    tenant_id: t,
    oa_id: oa,
    kind: "ai_generation",
    units: 3,
    provider: "sample",
    model: "sample",
    input_tokens: 1200,
    output_tokens: 400,
    cost_micros: 15000,
    currency: "USD",
    state: "confirmed",
    occurred_at: stamp,
  });
  // Stored sample states have no credentials; the showcase runtime rejects all external I/O.
  add("platform", "connections", {
    id: "showcase-drive",
    tenant_id: t,
    oa_id: oa,
    service: "google_drive:" + u,
    state: "connected",
    config: json({
      email: "demo@example.com",
      folderName: "架空の面談メモ",
      folderId: "showcase-folder",
    }),
    last_sync_at: stamp,
  });
  add("common", "teams", { id: "showcase-team", name: "本店営業（見本）" });
  const names = ["佐藤花子（架空）", "田中太郎（架空）", "鈴木あおい（架空）"];
  for (let i = 0; i < names.length; i++) {
    const cid = "showcase-customer-" + (i + 1),
      line = "showcase-line-" + (i + 1);
    add("common", "customers", {
      id: cid,
      name: names[i],
      owner_user_id: u,
      team_id: "showcase-team",
      stage: i === 1 ? "booked" : "prospect",
      confirmed_at: past,
      confirmed_by: u,
      created_at: past,
    });
    add("common", "customer_links", {
      oa_id: oa,
      line_user_id: line,
      customer_id: cid,
    });
    add("harness", "messages", {
      id: "showcase-message-" + i,
      customer_id: cid,
      line_user_id: line,
      direction: "inbound",
      source: "line",
      body:
        i === 0
          ? "渋谷区で5,000万円以内、2LDK、所有権の物件を探しています。駅から徒歩5分以内が希望です。"
          : "ご連絡ありがとうございます。週末に内見を希望します。",
      state: "received",
      occurred_at: past,
      recorded_at: past,
    });
  }
  add("harness", "appointments", {
    id: "showcase-appointment",
    customer_id: "showcase-customer-2",
    external_id: "showcase-booking",
    title: "内見予約（架空）",
    starts_at: future,
    ends_at: new Date(+at + 90000000).toISOString(),
    state: "booked",
    source: "timerex",
    attribution: "confirmed",
  });
  const note =
    "渋谷区で5,000万円以内、2LDK、所有権、駅徒歩5分以内を希望。条件に合えば週末の内見を検討。";
  add("studio", "context_notes", {
    id: "showcase-note",
    customer_id: "showcase-customer-1",
    source: "meeting",
    source_ref: "showcase-document",
    body: note,
    deal_state: "active",
    confirmed_by: u,
    confirmed_at: past,
    created_at: past,
  });
  const prefs = {
    area: "渋谷区",
    maxPrice: 50000000,
    required: ["2LDK", "所有権", "駅徒歩5分以内"],
    excluded: ["定期借地権"],
    walkingMinutes: 5,
    layout: "2LDK",
    tenure: "所有権",
  };
  add("studio", "assistant_preferences", {
    customer_id: "showcase-customer-1",
    note_id: "showcase-note",
    data: json(prefs),
    updated_at: past,
  });
  add("studio", "meeting_inbox", {
    id: "showcase-document",
    connection_id: "showcase-drive",
    title: "佐藤花子様 初回面談（架空）",
    mime_type: "text/plain",
    modified_at: past,
    detected_at: past,
    source_email: "demo@example.com",
    held_at: past,
    state: "confirmed",
    customer_id: "showcase-customer-1",
    customer_version: 1,
    confirmed_by: u,
    confirmed_at: past,
  });
  add("studio", "meeting_inbox", {
    id: "showcase-unlinked-document",
    connection_id: "showcase-drive",
    title: "田中太郎様 内見前のお電話（架空）",
    mime_type: "text/plain",
    modified_at: stamp,
    detected_at: stamp,
    source_email: "demo@example.com",
    held_at: stamp,
    state: "unlinked",
  });
  const source = {
    id: "showcase-property",
    kind: "product",
    industry: "estate",
    title: "【架空】渋谷ガーデン 301号室",
    url: "https://example.com/property/showcase",
    publishedAt: stamp,
    checkedAt: stamp,
    expiresAt: expires,
    summary:
      "渋谷区・4,800万円・2LDK・所有権・駅徒歩5分。画面説明用の架空物件。",
    tags: ["2LDK", "所有権", "駅徒歩5分以内"],
    absentTags: ["定期借地権"],
    area: "渋谷区",
    price: 48000000,
    status: "available",
    stock: 1,
    property: { walkingMinutes: 5, layout: "2LDK", tenure: "所有権" },
  };
  add("studio", "assistant_sources", {
    id: source.id,
    kind: source.kind,
    title: source.title,
    url: source.url,
    published_at: stamp,
    checked_at: stamp,
    expires_at: expires,
    data: json(source),
    updated_at: stamp,
  });
  add("studio", "assistant_settings", { id: "default", enabled: 1 });
  const draft =
    "佐藤様、ご希望の渋谷区で4,800万円・2LDK、所有権、駅徒歩5分の物件が出ました。条件に合いそうでしたのでご案内します。よろしければ内見のご都合をお知らせください。";
  add("studio", "proposals", {
    id: "showcase-proposal",
    customer_id: "showcase-customer-1",
    trigger: "assistant:product",
    reason: "議事録で確認した希望と、新しい物件の条件が一致",
    context_refs: json(["showcase-note"]),
    draft,
    confidence: "review",
    state: "pending",
    customer_version: 1,
    created_at: stamp,
    updated_at: stamp,
  });
  add("studio", "proposal_versions", {
    proposal_id: "showcase-proposal",
    version: 1,
    draft,
    actor_id: u,
    at: stamp,
  });
  add("studio", "assistant_proposals", {
    proposal_id: "showcase-proposal",
    dedupe_key: "showcase-proposal",
    kind: "product",
    line_user_id: "showcase-line-1",
    owner_user_id: u,
    evidence: json({
      businessVersion: 1,
      businessIndustry: "estate",
      publishedAt: stamp,
      checkedAt: stamp,
      eventAt: null,
      kind: "product",
      industry: "estate",
      sourceId: source.id,
      sourceVersion: 1,
      noteId: "showcase-note",
      noteBody: note,
      title: source.title,
      url: source.url,
      summary: source.summary,
      source,
      preferences: prefs,
      draftMode: "generated",
      draftDetail:
        "画面見学のために用意した文案です。実際のAI生成・送信は行いません。",
      messages: [],
      priority: 30,
    }),
    expires_at: expires,
  });
  add("studio", "style_profiles", {
    user_id: u,
    answers: json({ tone: "丁寧だが親しみのある言葉で、短めに伝える。" }),
    features: json({ tone: "丁寧・親しみ", emoji: "控えめ" }),
    state: "active",
    updated_at: stamp,
  });
  add("studio", "assistant_feedback", {
    id: "showcase-feedback",
    proposal_id: "showcase-proposal",
    version: 1,
    customer_id: "showcase-customer-1",
    actor_id: u,
    action: "edited",
    origin: "web",
    category: "style",
    original: "よろしくお願いいたします。",
    final: "よろしくお願いします。",
    note: "やわらかい締め方を好む（架空例）",
    context: "{}",
    at: past,
  });
  return sets;
}
