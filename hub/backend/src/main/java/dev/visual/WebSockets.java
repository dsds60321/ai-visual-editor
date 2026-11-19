package dev.visual;
import java.util.*;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.server.*;
import org.springframework.web.socket.*;
import org.springframework.web.socket.config.annotation.*;
import org.springframework.web.socket.server.HandshakeInterceptor;
@Configuration @EnableWebSocket
public class WebSockets implements WebSocketConfigurer {
    private final AgentBridge bridge;private final Accounts accounts;
    public WebSockets(AgentBridge bridge,Accounts accounts){this.bridge=bridge;this.accounts=accounts;}
    @Override public void registerWebSocketHandlers(WebSocketHandlerRegistry registry){
        registry.addHandler(bridge,"/agent").addInterceptors(new HandshakeInterceptor(){
            public boolean beforeHandshake(ServerHttpRequest req,ServerHttpResponse res,WebSocketHandler h,Map<String,Object> attrs){
                var user=req.getHeaders().getFirst("X-Agent-User");var auth=req.getHeaders().getFirst("Authorization");
                if(auth==null||!auth.startsWith("Bearer ")||!accounts.agent(user,auth.substring(7))){res.setStatusCode(org.springframework.http.HttpStatus.UNAUTHORIZED);return false;}
                attrs.put("user",user);return true;
            }
            public void afterHandshake(ServerHttpRequest req,ServerHttpResponse res,WebSocketHandler h,Exception ex){}
        });
    }
}
