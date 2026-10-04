import React, { useMemo, useState } from "react";
import {
  B,
  I,
  Tag,
  Tile,
  Brand,
  Title,
  Section,
  Field,
  Segments,
  Note,
  download,
} from "./ui.jsx";
const groups = [
  { id: "auth", label: "認証・権限" },
  { id: "activation", label: "企業・開通" },
  { id: "ledger", label: "利用量・監査" },
  { id: "data", label: "顧客・OA別データ" },
];
const stores = {
  platform: "プラットフォーム管理DB",
  common: "企業共通顧客DB",
  harness: "OA別 Harness DB",
  tsunagu: "OA別 TSUNAGU DB",
};
export function Structure({ model, go }) {
  const [tab, setTab] = useState("concept"),
    [group, setGroup] = useState("auth"),
    [selected, setSelected] = useState(null),
    [zoom, setZoom] = useState(1);
  const ids = model.entities.filter((e) => e.group === group).map((e) => e.id),
    rels = model.relationships.filter((r) => r.group === group),
    related = [...new Set([...ids, ...rels.flatMap((r) => [r.from, r.to])])];
  const nodes =
    tab === "concept"
      ? model.concept.nodes
      : model.entities
          .filter((e) => related.includes(e.id))
          .map((e, i) => ({
            ...e,
            row: Math.floor(i / 3),
            col: i % 3,
            description: stores[e.store],
            reference: e.group !== group,
          }));
  const edges = tab === "concept" ? model.concept.edges : rels;
  const entity = model.entities.find((e) => e.id === selected);
  function mermaid() {
    if (tab === "er")
      return (
        "erDiagram\n" +
        model.entities
          .filter((e) => related.includes(e.id))
          .map(
            (e) =>
              `  ${e.id} {\n${e.fields.map((f) => `    string ${f.name} ${f.key.startsWith("PK") ? "PK" : f.key.startsWith("FK") ? "FK" : ""}`).join("\n")}\n  }`,
          )
          .join("\n") +
        "\n" +
        rels.map((r) => `  ${r.from} ||--o{ ${r.to} : "${r.label}"`).join("\n")
      );
    return (
      "flowchart TB\n" +
      nodes.map((n) => `  ${n.id}["${n.label}"]`).join("\n") +
      "\n" +
      edges.map((e) => `  ${e.from} -->|"${e.label}"| ${e.to}`).join("\n")
    );
  }
  return (
    <div className="pt-structure">
      <header>
        <Brand onClick={() => go("/")} />
        <button className="pt-text-link" onClick={() => go("/")}>
          <I name="ArrowLeft" size={15} />
          レビュー入口
        </button>
      </header>
      <Title
        eyebrow="ONE MODEL, THREE PERSPECTIVES"
        title="体験と構造を、ひとつにつなぐ。"
        description="画面・概念・ER図は、同じ model.json を参照しています。"
      >
        <Tag tone="lavender">MODEL v{model.version}</Tag>
        <B
          variant="secondary"
          icon="Download"
          onClick={() =>
            download(
              "model.json",
              JSON.stringify(model, null, 2),
              "application/json",
            )
          }
        >
          model.json
        </B>
      </Title>
      <div className="pt-canvas-toolbar">
        <Segments
          label="構造キャンバスの表示"
          value={tab}
          options={[
            { id: "screens", label: "画面マップ" },
            { id: "concept", label: "概念図" },
            { id: "er", label: "ER図" },
          ]}
          onChange={(v) => {
            setTab(v);
            setSelected(null);
            setZoom(1);
          }}
        />
        {tab === "er" && (
          <Field label="領域">
            <select
              value={group}
              onChange={(e) => {
                setGroup(e.target.value);
                setSelected(null);
              }}
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {tab !== "screens" && (
          <div className="pt-canvas-controls">
            <button
              aria-label="図を縮小"
              onClick={() => setZoom(Math.max(0.6, zoom - 0.1))}
            >
              −
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              aria-label="図を拡大"
              onClick={() => setZoom(Math.min(1.6, zoom + 0.1))}
            >
              ＋
            </button>
            <B
              variant="ghost"
              icon="Download"
              onClick={() => download(`tsunagu-${tab}-${group}.mmd`, mermaid())}
            >
              Mermaid
            </B>
          </div>
        )}
      </div>
      {tab === "screens" ? (
        <div className="pt-screen-map">
          {[
            ["auth", "共通ログイン", "LogIn"],
            ["customer", "顧客の導入", "Rocket"],
            ["ops", "TSUNAGU運営 /ops", "Layers"],
            ["sales", "顧客向け営業体験", "Sparkles"],
            ["restricted", "期限付きサポート", "LockKeyhole"],
          ].map(([area, label, icon]) => (
            <section key={area}>
              <header>
                <Tile
                  name={icon}
                  tone={area === "ops" ? "peach" : "lavender"}
                />
                <div>
                  <h2>{label}</h2>
                  <small>
                    {area === "ops"
                      ? "通常は会話本文を表示しない"
                      : area === "restricted"
                        ? "承認・範囲・期限を照合"
                        : "独立したレビュー導線"}
                  </small>
                </div>
              </header>
              {model.screens
                .filter((s) => s.area === area)
                .map((s) => (
                  <button
                    className="pt-screen-node"
                    key={s.id}
                    onClick={() => go(s.path)}
                  >
                    <div>
                      <strong>{s.label}</strong>
                      <small>{s.path}</small>
                      <p>{s.description}</p>
                    </div>
                    <I name="ArrowUpRight" size={16} />
                  </button>
                ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="pt-canvas-layout">
          <div className="pt-canvas-surface">
            <div className="pt-canvas-label">
              <Tag tone="stone">
                {tab === "concept"
                  ? "独立DBの所属と参照関係"
                  : "論理エンティティと関連"}{" "}
                / クリックで詳細
              </Tag>
              <button onClick={() => setSelected(null)}>選択を解除</button>
            </div>
            <Graph
              nodes={nodes}
              edges={edges}
              selected={selected}
              select={setSelected}
              zoom={zoom}
            />
            <div className="pt-canvas-legend">
              <span>
                <i />
                選択中
              </span>
              <span>
                <i />
                関連するエンティティ
              </span>
              <span>
                {tab === "er"
                  ? "1 : N = 一対多の論理関係。DB間は参照IDで関連付け。"
                  : "字下げや線は所属・参照を示し、DBの入れ子ではありません。"}
              </span>
            </div>
          </div>
          <aside className="pt-canvas-inspector">
            {selected ? (
              <>
                <span className="pt-overline">SELECTED NODE</span>
                <h2>{nodes.find((n) => n.id === selected)?.label}</h2>
                <p>{nodes.find((n) => n.id === selected)?.description}</p>
                {entity && tab === "er" ? (
                  <>
                    <Tag tone="lavender">{stores[entity.store]}</Tag>
                    <h3>フィールド</h3>
                    <div className="pt-entity-fields">
                      {entity.fields.map((f) => (
                        <div key={f.name}>
                          <code>{f.name}</code>
                          {f.key && (
                            <Tag tone={f.key === "PK" ? "peach" : "stone"}>
                              {f.key}
                            </Tag>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <Note>
                    {
                      model.principles[
                        selected === "tsunagu"
                          ? 4
                          : selected === "platform"
                            ? 5
                            : selected === "oa"
                              ? 2
                              : 3
                      ]
                    }
                  </Note>
                )}
                <h3>つながり</h3>
                {edges
                  .filter((e) => e.from === selected || e.to === selected)
                  .map((e, i) => (
                    <div className="pt-inspector-link" key={i}>
                      <span>
                        {
                          nodes.find(
                            (n) =>
                              n.id === (e.from === selected ? e.to : e.from),
                          )?.label
                        }
                      </span>
                      <small>
                        {e.label}
                        {tab === "er" ? " · " + e.cardinality : ""}
                      </small>
                    </div>
                  ))}
              </>
            ) : (
              <>
                <Tile name="MousePointer2" />
                <h2>構造を選んで、確かめる。</h2>
                <p>
                  図のノードをクリックすると、保存先・フィールド・関連を確認できます。
                </p>
                <div className="pt-model-counts">
                  <span>
                    <strong>{model.screens.length}</strong>画面定義
                  </span>
                  <span>
                    <strong>{model.entities.length}</strong>エンティティ
                  </span>
                  <span>
                    <strong>{model.relationships.length}</strong>関連
                  </span>
                </div>
                <Note>
                  秘密情報の実値は含みません。資格情報はメタデータと保管先参照だけを表現しています。
                </Note>
              </>
            )}
          </aside>
        </div>
      )}
      <div className="pt-model-notes">
        <Section
          title="採用した基本方針"
          sub="添付設計案の合意済み事項を反映。"
        >
          {model.principles.map((p) => (
            <p key={p}>
              <I name="CheckCircle2" size={16} />
              {p}
            </p>
          ))}
        </Section>
        <Section
          title="本番実装前の技術検証"
          sub="モックの動作は、実現確認済みを意味しません。"
        >
          {model.pendingValidation.map((p) => (
            <p key={p}>
              <I name="Clock" size={16} />
              {p}
            </p>
          ))}
        </Section>
      </div>
    </div>
  );
}
function Graph({ nodes, edges, selected, select, zoom }) {
  const width = 880,
    height = Math.max(...nodes.map((n) => n.row), 0) * 150 + 155,
    pos = Object.fromEntries(
      nodes.map((n) => [n.id, { x: 28 + n.col * 286, y: 30 + n.row * 150 }]),
    );
  const adjacent = new Set(
    edges
      .filter((e) => e.from === selected || e.to === selected)
      .flatMap((e) => [e.from, e.to]),
  );
  return (
    <div className="pt-graph-scroll">
      <svg
        className="pt-graph"
        viewBox={`0 0 ${width} ${height}`}
        style={{
          width: width * zoom,
          maxWidth: zoom <= 1 ? "100%" : undefined,
        }}
        role="img"
        aria-label="共通モデルから生成した関係図"
      >
        <defs>
          <marker
            id="pt-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const a = pos[e.from],
            b = pos[e.to];
          if (!a || !b) return null;
          const highlight =
              selected && (e.from === selected || e.to === selected),
            same = a.y === b.y;
          const x1 = same ? a.x + 250 : a.x + 125,
            y1 = same ? a.y + 44 : a.y + 87,
            x2 = same ? b.x : b.x + 125,
            y2 = same ? b.y + 44 : b.y;
          const bend = same
            ? `C ${x1 + 38} ${y1 + 90}, ${x2 - 38} ${y2 + 90}, ${x2} ${y2}`
            : `C ${x1} ${y1 + 32}, ${x2} ${y2 - 32}, ${x2} ${y2}`;
          return (
            <g
              key={i}
              className={`pt-edge ${highlight ? "highlight" : ""}`}
              style={{ opacity: selected && !highlight ? 0.12 : undefined }}
            >
              <path d={`M ${x1} ${y1} ${bend}`} markerEnd="url(#pt-arrow)" />
              {highlight && (
                <g>
                  <rect
                    x={(x1 + x2) / 2 - 78}
                    y={(y1 + y2) / 2 - 11}
                    width="156"
                    height="22"
                    rx="7"
                    fill="#fcfbff"
                  />
                  <text
                    x={(x1 + x2) / 2}
                    y={(y1 + y2) / 2 + 4}
                    textAnchor="middle"
                  >
                    {e.label}
                    {e.cardinality ? " · " + e.cardinality : ""}
                  </text>
                </g>
              )}
            </g>
          );
        })}
        {nodes.map((n) => {
          const { x, y } = pos[n.id];
          return (
            <g
              className={`pt-graph-node ${selected === n.id ? "selected" : ""} ${adjacent.has(n.id) ? "related" : ""} ${n.reference ? "reference" : ""}`}
              key={n.id}
              transform={`translate(${x},${y})`}
              role="button"
              tabIndex={0}
              aria-label={n.label}
              aria-pressed={selected === n.id}
              onClick={() => select(n.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  select(n.id);
                }
              }}
            >
              <rect width="250" height="88" rx="14" />
              <circle cx="20" cy="22" r="4" />
              <text className="pt-node-label" x="34" y="27">
                {n.label}
              </text>
              <text className="pt-node-description" x="18" y="54">
                {(n.description || "").slice(0, 23)}
              </text>
              <text className="pt-node-id" x="18" y="72">
                {n.reference ? "参照先 / " : ""}
                {n.id}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
