import { randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * 生成指定长度的随机十六进制字符串。
 *
 * @param length 目标字符数
 * @returns 小写十六进制随机串
 */
function randomHex(length: number): string {
  // 每字节对应 2 个 hex 字符，向上取整后截断到目标长度
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

/**
 * 基于原始文件名生成唯一上传文件名。
 * 同一请求中多个文件可能同名但内容不同；ComfyUI 按文件名引用资源，
 * 若直接使用原始名并 overwrite，后上传的会覆盖先上传的，导致节点加载错乱。
 *
 * @param originalname 用户上传的原始文件名
 * @returns 保留扩展名、包含原始主体名与 6 位随机后缀的唯一文件名
 */
export function buildUniqueUploadFilename(originalname: string): string {
  // 分离扩展名与主体名
  const ext = path.extname(originalname);
  const base = path.basename(originalname, ext);

  // 清理不安全字符，避免路径注入；空主体时回退为 file
  const safeBase = (base || 'file')
    .replace(/[^\w.\-()+ ]+/g, '_')
    .slice(0, 80) || 'file';

  // 6 位随机后缀足以区分同一次请求内的同名文件
  return `${safeBase}_${randomHex(6)}${ext}`;
}
