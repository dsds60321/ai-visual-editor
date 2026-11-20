package dev.visual;
import java.util.*;
import java.util.concurrent.*;
import java.io.IOException;
import com.fasterxml.jackson.databind.*;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
@Component
public class AgentBridge extends TextWebSocketHandler {
    private static final org.slf4j.Logger LOG = org.slf4j.LoggerFactory.getLogger(AgentBridge.class);
    private final ObjectMapper mapper;
    private final ConcurrentHashMap<String,WebSocketSession> agents=new ConcurrentHashMap<>();
    private record Pending(String user,String sessionId,CompletableFuture<JsonNode> future) {}
    private record Subscription(String user,String taskId,SseEmitter emitter) {}
    private final Set<Subscription> subscriptions=ConcurrentHashMap.newKeySet();
    // Slow browsers must not hold up Agent replies or grow an unbounded delivery queue.
    private final ThreadPoolExecutor streamWriter=new ThreadPoolExecutor(1,1,0,TimeUnit.SECONDS,new ArrayBlockingQueue<>(256),work->{
        var thread=new Thread(work,"chat-stream");thread.setDaemon(true);return thread;
    },new ThreadPoolExecutor.DiscardPolicy());
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
        var m=mapper.readTree(message.getPayload());
        var user=(String)s.getAttributes().get("user");
        var connected=agents.get(user);
        if(connected==null||!s.getId().equals(connected.getId()))return;
        if(m.has("event")){
            var taskId=m.path("taskId").asText();
            var event=m.path("event");
            if(!event.isObject()||!event.path("seq").canConvertToLong())return;
            var recipients=subscriptions.stream().filter(stream->stream.user().equals(user)&&stream.taskId().equals(taskId)).toList();
            if(recipients.isEmpty())return;
            streamWriter.execute(()->{
                for(var subscription:recipients){
                    if(!subscriptions.contains(subscription))continue;
                    try{subscription.emitter().send(SseEmitter.event().data(event,org.springframework.http.MediaType.APPLICATION_JSON));}
                    catch(IOException|IllegalStateException error){subscriptions.remove(subscription);}
                }
            });
            return;
        }
        var id=m.path("id").asText();var p=pending.get(id);
        if(p!=null&&p.sessionId().equals(s.getId())&&p.user().equals(user)&&pending.remove(id,p))p.future().complete(m);
    }

    public synchronized SseEmitter stream(String user,String taskId) throws IOException {
        if(subscriptions.size()>=16)throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE);
        var emitter=new SseEmitter(45_000L);
        var subscription=new Subscription(user,taskId,emitter);
        emitter.onCompletion(()->subscriptions.remove(subscription));
        emitter.onTimeout(emitter::complete);
        emitter.onError(error->subscriptions.remove(subscription));
        emitter.send(SseEmitter.event().comment("connected"));
        subscriptions.add(subscription);
        return emitter;
    }

    @org.springframework.context.event.EventListener
    public void closeAgents(org.springframework.context.event.ContextClosedEvent event) {
        var shutdown = new CloseStatus(4000, "Hub shutdown");
        for (var agent : agents.values()) {
            try { agent.close(shutdown); }
            catch (IOException error) { LOG.warn("Could not notify Agent of Hub shutdown", error); }
        }
        streamWriter.shutdownNow();
        for(var subscription:subscriptions)subscription.emitter().complete();
    }

    public boolean connected(String user){var s=agents.get(user);return s!=null&&s.isOpen();}
    public JsonNode call(String user,String method,Object params) throws Exception {
        var s=agents.get(user);if(s==null||!s.isOpen())throw new IllegalStateException("본인 PC의 Agent를 연결하세요");
        var id=UUID.randomUUID().toString();var f=new CompletableFuture<JsonNode>();pending.put(id,new Pending(user,s.getId(),f));
        try {
            s.sendMessage(new TextMessage(mapper.writeValueAsString(Map.of("id",id,"method",method,"params",params))));
            var result=f.get(method.equals("create")||method.equals("restart")||method.equals("start-preview")||method.equals("revert-request")?195:90,TimeUnit.SECONDS);
            if(result.has("error"))throw new IllegalArgumentException(result.path("error").asText());
            return result.get("result");
        }finally{pending.remove(id);}
    }
}
