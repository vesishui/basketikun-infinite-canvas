import { useMemo, useState } from "react";
import { Button, Input, Tag } from "antd";
import { Bot, SendHorizontal, User } from "lucide-react";
import { useConfigStore } from "@/stores/use-config-store";
import { useAgentStore } from "@/stores/use-agent-store";

type DirectMessage = { role: "user" | "assistant"; content: string };

/** 画布渠道直连对话：复用画布配置的渠道（第三方中转经常改配置，这里自动跟随），
 *  经 canvas-agent 的 /agent/direct/chat 流式转发到 /chat/completions。 */
export function DirectChatPanel() {
    const config = useConfigStore((state) => state.config);
    const agentUrl = useAgentStore((state) => state.url);
    const agentToken = useAgentStore((state) => state.token);
    const connected = useAgentStore((state) => state.connected);
    const [messages, setMessages] = useState<DirectMessage[]>([]);
    const [input, setInput] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState("");

    // 解析画布当前文本渠道（textModel 格式为 channelId::modelName）
    const channel = useMemo(() => {
        const channels = config.channels || [];
        if (!channels.length) return null;
        const textModel = config.textModel || "";
        const [channelId, modelName] = textModel.split("::");
        const ch = channels.find((item) => item.id === channelId) || channels[0];
        const model =
            (modelName && ch.models.some((item) => item.name === modelName) ? modelName : null) ||
            ch.models.find((item) => item.capability === "text")?.name ||
            ch.models[0]?.name ||
            "";
        return { baseUrl: ch.baseUrl, apiKey: ch.apiKey, model, name: ch.name };
    }, [config]);

    const send = async () => {
        const text = input.trim();
        if (!text || sending || !channel || !agentUrl) return;
        if (!connected || !agentToken) {
            setError("请先连接本地 Agent（右上角 Agent 面板填 Connect token）");
            return;
        }
        if (!channel.baseUrl || !channel.apiKey || !channel.model) {
            setError("画布渠道未完整配置（Base URL / API Key / 模型）");
            return;
        }
        const history: DirectMessage[] = [...messages, { role: "user", content: text }];
        setMessages([...history, { role: "assistant", content: "" }]);
        setInput("");
        setSending(true);
        setError("");
        try {
            const res = await fetch(`${agentUrl}/agent/direct/chat?token=${encodeURIComponent(agentToken)}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ baseUrl: channel.baseUrl, apiKey: channel.apiKey, model: channel.model, messages: history }),
            });
            if (!res.ok) {
                const data = (await res.json().catch(() => ({}))) as { error?: string };
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            const reader = res.body?.getReader();
            if (!reader) throw new Error("无法读取响应流");
            const decoder = new TextDecoder();
            let assistant = "";
            let buffer = "";
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith("data:")) continue;
                    const payload = trimmed.slice(5).trim();
                    if (!payload || payload === "[DONE]") continue;
                    try {
                        const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
                        const delta = json.choices?.[0]?.delta?.content || "";
                        if (delta) {
                            assistant += delta;
                            setMessages((prev) => {
                                const next = [...prev];
                                next[next.length - 1] = { role: "assistant", content: assistant };
                                return next;
                            });
                        }
                    } catch {
                        /* 忽略非 JSON 行 */
                    }
                }
            }
        } catch (err) {
            setMessages((prev) => prev.slice(0, -1));
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="flex flex-col gap-2 rounded-xl border border-stone-200 p-3 dark:border-stone-700/60">
            <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                    <Bot className="size-4 shrink-0" />
                    <span>画布渠道对话</span>
                </div>
                {channel ? (
                    <Tag color="blue" className="!m-0 max-w-[60%] truncate" title={`${channel.baseUrl} · ${channel.model}`}>
                        {channel.name} · {channel.model}
                    </Tag>
                ) : (
                    <Tag className="!m-0">未配置渠道</Tag>
                )}
            </div>
            {messages.length === 0 && !error ? (
                <div className="px-1 py-3 text-center text-xs opacity-60">
                    直接使用画布配置的渠道对话，画布配置改动后这里自动跟随。
                </div>
            ) : (
                <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
                    {messages.map((message, index) => (
                        <div key={index} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                            <div
                                className={`flex max-w-[85%] items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-sm leading-relaxed ${
                                    message.role === "user"
                                        ? "bg-blue-600/15 text-stone-800 dark:text-stone-100"
                                        : "bg-stone-100 text-stone-800 dark:bg-stone-800 dark:text-stone-100"
                                }`}
                            >
                                {message.role === "assistant" ? <Bot className="mt-0.5 size-3.5 shrink-0 opacity-60" /> : <User className="mt-0.5 size-3.5 shrink-0 opacity-60" />}
                                <span className="whitespace-pre-wrap break-words">{message.content || (sending && index === messages.length - 1 ? "…" : "")}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            {error && <div className="px-1 text-xs text-red-500">{error}</div>}
            <div className="flex gap-2">
                <Input.TextArea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="输入消息，回车发送（Shift+Enter 换行）"
                    autoSize={{ minRows: 1, maxRows: 4 }}
                    disabled={!channel || sending}
                    onPressEnter={(event) => {
                        if (!event.shiftKey) {
                            event.preventDefault();
                            void send();
                        }
                    }}
                />
                <Button type="primary" icon={<SendHorizontal className="size-4" />} loading={sending} disabled={!channel || !input.trim()} onClick={() => void send()}>
                    发送
                </Button>
            </div>
        </div>
    );
}
