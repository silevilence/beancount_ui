/** 工作台与访问页共用的应用标识。文字已提供名称，图片避免重复朗读。 */
export default function Brand() {
  return (
    <div className="brand">
      <img
        className="brand-mark"
        src="/icons/app-icon-64.png"
        srcSet="/icons/app-icon-128.png 2x"
        width="44"
        height="44"
        alt=""
      />
      <span>
        日用账本
        <small>THE DAILY LEDGER · 本地记账</small>
      </span>
    </div>
  );
}
