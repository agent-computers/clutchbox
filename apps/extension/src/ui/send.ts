import type { CaptureRequest, Response, StatusResponse } from '@clutchbox/capture';

export async function send(request: CaptureRequest): Promise<StatusResponse> {
  const response: Response = await chrome.runtime.sendMessage(request);
  if (!response.ok) throw new Error(response.error);
  return response;
}
