package dev.visual;
import java.util.*;
import java.util.concurrent.*;
import java.io.IOException;
import com.fasterxml.jackson.databind.*;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
@Component
public class AgentBridge extends TextWebSocketHandler {
    private final ObjectMapper mapper;
    private final ConcurrentHashMap<String,WebSocketSession> agents=new ConcurrentHashMap<>();
    private record Pending(String user,String sessionId,CompletableFuture<JsonNode> future) {}
    private final ConcurrentHashMap<String,Pending> pending=new ConcurrentHashMap<>();
    public AgentBridge(ObjectMapper mapper){this.mapper=mapper;}
    @Override public void afterConnectionEstablished(WebSocketSession raw) throws Exception {
        raw.setTextMessageSizeLimit(16_000_000);
        String user=(String)raw.getAttributes().get("user");
        var session=new ConcurrentWebSocketSessionDecorator(raw,10000,16_000_000);
        var old=agents.putIfAbsent(user,session);if(old!=null)raw.close(CloseStatus.POLICY_VIOLATION);
    }
    @Override public void afterConnectionClosed(WebSocketSession s,CloseStatus status) {
        agents.entrySet().removeIf(e->e.getValue().getId().equals(s.getId()));
        pending.forEach((id,p)->{if(p.sessionId().equals(s.getId())&&pending.remove(id,p))p.future().completeExceptionally(new IllegalStateException("Agent 연결 종료"));});
    }
    @Override protected void handleTextMessage(WebSocketSession s,TextMessage message) throws IOException {
        var m=mapper.readTree(message.getPayload());var id=m.path("id").asText();var p=pending.get(id);
        if(p!=null&&p.sessionId().equals(s.getId())&&p.user().equals(s.getAttributes().get("user"))&&pending.remove(id,p))p.future().complete(m);
    }
    public boolean connected(String user){var s=agents.get(user);return s!=null&&s.isOpen();}
    public JsonNode call(String user,String method,Object params) throws Exception {
        var s=agents.get(user);if(s==null||!s.isOpen())throw new IllegalStateException("본인 PC의 Agent를 연결하세요");
        var id=UUID.randomUUID().toString();var f=new CompletableFuture<JsonNode>();pending.put(id,new Pending(user,s.getId(),f));
        try {
            s.sendMessage(new TextMessage(mapper.writeValueAsString(Map.of("id",id,"method",method,"params",params))));
            var result=f.get(method.equals("create")||method.equals("restart")||method.equals("start-preview")?195:90,TimeUnit.SECONDS);
            if(result.has("error"))throw new IllegalArgumentException(result.path("error").asText());
            return result.get("result");
        }finally{pending.remove(id);}
    }
}
