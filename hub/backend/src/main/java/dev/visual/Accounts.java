package dev.visual;
import java.nio.file.*;
import java.util.*;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;
@Component
public class Accounts {
    @JsonIgnoreProperties("passwordHash")
    public record Account(String username,String agentToken) {}
    private final List<Account> users;
    public Accounts(ObjectMapper mapper, @org.springframework.beans.factory.annotation.Value("${hub.users-file:../../.data/users.json}") String file) throws Exception {
        users=List.of(mapper.readValue(Files.readString(Path.of(file)),Account[].class));
        if(users.isEmpty() || users.stream().anyMatch(a->a.username()==null || a.username().isBlank() || a.agentToken()==null || a.agentToken().length()<32) || users.stream().map(Account::username).distinct().count()!=users.size()) throw new IllegalArgumentException("Invalid users file");
    }
    public String localUsername(){return users.getFirst().username();}
    public boolean agent(String user,String token) {
        if(user==null||token==null)return false;
        return users.stream().anyMatch(a->a.username().equals(user)&&java.security.MessageDigest.isEqual(a.agentToken().getBytes(java.nio.charset.StandardCharsets.UTF_8),token.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }
}
