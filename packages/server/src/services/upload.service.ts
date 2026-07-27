/** 将文件上传到 ComfyUI，返回 ComfyUI 存储的文件名 */
export async function uploadFileToComfyUI(
  file: { buffer: Buffer; originalname: string; mimetype: string },
  mediaType: 'image' | 'video' | 'audio',
  comfyuiBaseUrl: string,
): Promise<string> {
  const endpoint = mediaType === 'image' ? '/upload/image' : `/upload/${mediaType}`;
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype });
  formData.append('image', blob, file.originalname);
  formData.append('type', 'input');
  formData.append('overwrite', 'true');

  const response = await fetch(`${comfyuiBaseUrl}${endpoint}`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ComfyUI upload failed (${response.status}): ${text}`);
  }

  const result = (await response.json()) as { name: string };
  return result.name;
}
