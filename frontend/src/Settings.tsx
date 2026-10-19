import { useState } from "react";
import LayoutDialog from "./LayoutDialog";
import SyncDialog from "./SyncDialog";

/** One settings entry point; editors keep their existing validation and storage. */
export default function Settings({ onChanged, grocy }: {
  onChanged: () => Promise<void>;
  grocy?: React.ReactNode;
}) {
  const [editor, setEditor] = useState("");
  return <section className="settings-page">
    <header className="page-heading"><p className="eyebrow">PREFERENCES / 日常配置</p><h1>设置</h1>
      <p className="muted">管理账本的录入规则、备份连接与库存服务。</p></header>
    <div className="settings-grid">
      <section className="panel card"><h2>布局与业务模板</h2>
        <p>配置文件路由、包含关系与录入字段。沿用当前账本规则，预览后启用。</p>
        <button onClick={() => setEditor("layout")}>编辑布局与模板</button></section>
      <section className="panel card"><h2>GitHub 与自动备份</h2>
        <p>管理 GitHub 认证、网络代理和定时备份。立即备份仍可从顶部快捷进入。</p>
        <button onClick={() => setEditor("backup")}>编辑备份设置</button></section>
      <section className="panel card settings-wide"><h2>Grocy 连接与入库默认值</h2>
        {grocy ?? <p className="muted">库存联动尚未配置；普通记账可继续使用。</p>}</section>
    </div>
    <p className="muted small">账本目录、服务监听与访问认证由部署配置管理。</p>
    {editor === "layout" && <LayoutDialog onClose={() => setEditor("")} onChanged={onChanged} />}
    {editor === "backup" && <SyncDialog onClose={() => setEditor("")} onChanged={onChanged} />}
  </section>;
}
