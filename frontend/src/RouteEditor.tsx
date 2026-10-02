import TemplateSettings from "./TemplateSettings";
import {
  businessNames,
  businessKind,
  entryModeLabel,
  chainOf,
  routeLabel,
  type BusinessRoute,
  type Layout,
} from "./businessConfig";
import { Chip, Notice, Segmented } from "./ui";

/**
 * 单个业务的路由与模板编辑面板；只展示当前选中的业务，
 * 字段名不随业务名称变化，避免同屏出现多套相似标签。
 */
export default function RouteEditor({
  layout,
  business,
  original,
  day,
  writeDay,
  files,
  issues,
  onChange,
  onRemove,
}: {
  layout: Layout;
  business: string;
  original?: BusinessRoute;
  day: string;
  writeDay: string;
  files?: string[];
  issues: string[];
  onChange: (layout: Layout) => void;
  onRemove: () => void;
}) {
  const route = layout.routes[business];
  const builtIn = business in businessNames;
  const name = routeLabel(business, route.label);
  const indexes = route.indexes.filter((path) => path.trim());
  const chain = chainOf(layout.entry, { ...route, indexes }, day, writeDay);
  const writing = route.date_source === "write";
  const changed = JSON.stringify(route) !== JSON.stringify(original);
  function patch(changes: Partial<BusinessRoute>) {
    onChange({
      ...layout,
      routes: { ...layout.routes, [business]: { ...route, ...changes } },
    });
  }
  return (
    <div className="route-editor">
      <div className="work-head">
        <h3>{name}</h3>
        <div className="item-meta">
          <Chip tone={builtIn ? "muted" : "transfer"}>
            {builtIn ? "内置业务" : `自定义 · ${business}`}
          </Chip>
          <Chip>
            {businessNames[builtIn ? business : route.kind || "ordinary"]}
          </Chip>
          <Chip tone={route.template ? "ok" : "muted"}>
            {entryModeLabel(business, route)}
          </Chip>
          {changed && <Chip tone="warn">未启用的修改</Chip>}
        </div>
      </div>
      {issues.length > 0 && (
        <Notice tone="warn">
          <span>需要修正后才能通过服务器校验：</span>
          <ul className="issue-list">
            {issues.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Notice>
      )}
      <div className="form-grid">
        <label className="field">
          <span>业务名称</span>
          <input
            aria-label="业务名称"
            value={route.label || ""}
            placeholder={businessNames[business] || business}
            onChange={(e) => patch({ label: e.target.value })}
          />
          <small>
            仅用于界面显示；重命名不移动历史记录，也不改变文件位置。
          </small>
        </label>
        {!builtIn && (
          <label className="field">
            <span>记账语义</span>
            <select
              aria-label="记账语义"
              value={route.kind || "ordinary"}
              disabled={!!original}
              onChange={(e) => patch({ kind: e.target.value })}
            >
              {Object.entries(businessNames).map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
            <small>
              {original
                ? "已启用业务的记账语义不可更改；需要新语义请另建业务标识。"
                : "工资保留标签、收益按交易日期查重、余额只接受断言；启用后不可更改。"}
            </small>
          </label>
        )}
        <label className="field">
          <span>目标文件</span>
          <input
            aria-label="目标文件"
            value={route.target}
            onChange={(e) => patch({ target: e.target.value })}
          />
          <small>
            账本内相对路径，支持 {"{year}"}、{"{month}"}、{"{day}"}{" "}
            占位符或固定文件。
          </small>
        </label>
        <div className="field">
          <span>路径日期来源</span>
          <Segmented
            label="路径日期来源"
            value={route.date_source || "record"}
            options={[
              {
                value: "record",
                label: "交易日期",
                hint: "按记录发生日期生成路径",
              },
              {
                value: "write",
                label: "实际写入日期",
                hint: "按服务器当天生成路径，与交易日期独立",
              },
            ]}
            onChange={(value) =>
              patch({ date_source: value as "record" | "write" })
            }
          />
          <small>
            {writing
              ? `补记历史日期时写入服务器当天 ${writeDay} 的文件，记录日期保持不变。`
              : "按记录的交易日期生成路径，跨月补记会写入对应月份。"}
          </small>
        </div>
      </div>
      <label className="field">
        <span>索引链</span>
        <textarea
          aria-label="索引链"
          rows={3}
          spellCheck={false}
          value={route.indexes.join("\n")}
          onChange={(e) => patch({ indexes: e.target.value.split("\n") })}
        />
        <small>
          每行一个路径，按 入口 → 索引 → 目标文件 依次
          include；留空表示入口直接包含目标文件。
        </small>
      </label>
      <div className="chain" role="group" aria-label="包含链预览">
        {chain.map((path, index) => (
          <span className="chain-step" key={`${index}-${path}`}>
            <code>{path}</code>
            <em>
              {index === 0
                ? "入口"
                : index === chain.length - 1
                  ? "目标"
                  : "索引"}
            </em>
            {files &&
              (files.includes(path) ? (
                <i className="chain-state">已有</i>
              ) : (
                <i className="chain-state new">新建</i>
              ))}
          </span>
        ))}
      </div>
      <p className="muted small">
        预览日期 {day}
        {writing && ` · 该业务使用服务器当天 ${writeDay}`}；新建文件与 include
        链在保存新记录时才写入。
      </p>
      <TemplateSettings
        key={business}
        name={name}
        kind={businessKind(business, route)}
        value={route.template}
        onChange={(template) => patch({ template })}
      />
      {!builtIn && (
        <div className="toolbar">
          <button
            type="button"
            className="ghost small danger"
            onClick={onRemove}
          >
            移除「{name}」（保留历史记录）
          </button>
        </div>
      )}
    </div>
  );
}
