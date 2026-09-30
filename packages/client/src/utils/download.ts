/**
 * 浏览器下载与资源地址工具。
 *
 * 背景：开启接口鉴权（`auth_enabled=1`）后，受保护接口只认 `Authorization: Bearer` 头，
 * 而 `<img>` / `<video>` / `<audio>` / `<a href>` 这类**浏览器原生请求**完全不带自定义头，
 * 直接把这些接口地址交给浏览器会得到 401。因此这类资源必须先经 axios（拦截器附加 token）
 * 取回 Blob，再在本地生成临时 object URL 使用。
 */

/**
 * 触发浏览器保存 Blob：创建临时 object URL 并模拟点击，随后立即释放。
 * @param blob 文件内容
 * @param filename 保存文件名
 */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * 判断地址是否为可直接交给浏览器原生加载的绝对 http(s) 地址。
 *
 * 执行端直连（`direct` 下载模式）返回的是执行端/平台的绝对地址，浏览器可直连且无需本站鉴权；
 * 本站相对路径（如 `/api/tasks/...` 代理路径）受鉴权保护，原生请求会得到 401。
 * @param url 待判断的地址
 * @returns 是否为绝对 http(s) 地址
 */
export function isAbsoluteHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
