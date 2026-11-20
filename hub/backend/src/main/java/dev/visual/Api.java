package dev.visual;

import java.security.Principal;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

import com.fasterxml.jackson.databind.*;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.*;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class Api {
    private final AgentBridge bridge;

    record Ownership(String user, String ticket) {
    }

    private final ConcurrentHashMap<String, Ownership> tasks = new ConcurrentHashMap<>();
    private final java.nio.file.Path state;
    public Api(AgentBridge bridge, @org.springframework.beans.factory.annotation.Value("${hub.data-dir:../../.data/hub}") String dataDir) {
        this.bridge = bridge;
        state = java.nio.file.Path.of(dataDir, "tasks.json");
    }

    @jakarta.annotation.PreDestroy
    void deleteLegacyTaskState() throws java.io.IOException {
        java.nio.file.Files.deleteIfExists(state);
    }

    @GetMapping("/api/session")
    public Object session(Principal user, HttpServletRequest req) {
        var csrf = (CsrfToken) req.getAttribute(CsrfToken.class.getName());
        return Map.of("user", user.getName(), "connected", bridge.connected(user.getName()), "csrf", csrf.getToken(), "csrfHeader", csrf.getHeaderName());
    }

    @GetMapping("/api/projects")
    public Object projects(Principal user) throws Exception {
        return bridge.call(user.getName(), "projects", Map.of());
    }

    @GetMapping("/api/models")
    public Object models(Principal user) throws Exception {
        return bridge.call(user.getName(), "models", Map.of());
    }

    @PostMapping("/api/tasks")
    public Object create(Principal user, @RequestBody JsonNode body) throws Exception {
        var task = bridge.call(user.getName(), "create", Map.of("projectId", body.path("projectId").asText()));
        tasks.putIfAbsent(task.path("id").asText(), new Ownership(user.getName(), task.path("previewBase").asText().substring(task.path("previewBase").asText().lastIndexOf('/') + 1)));
        return task;
    }

    void own(String task, Principal user) {
        if (!tasks.containsKey(task) || !user.getName().equals(tasks.get(task).user()))
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "작업 없음");
    }

    @GetMapping("/api/tasks/{id}")
    public Object status(Principal user, @PathVariable String id) throws Exception {
        own(id, user);
        return bridge.call(user.getName(), "status", Map.of("taskId", id));
    }

    @PostMapping("/api/tasks/{id}/{action}")
    public Object action(Principal user, @PathVariable String id, @PathVariable String action, @RequestBody Map<String, Object> body) throws Exception {
        own(id, user);
        if (!Set.of("chat", "diff", "apply", "stop", "discard", "restart", "start-preview", "stop-preview", "interactive-preview", "request-diff", "revert-request").contains(action))
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        var params = new HashMap<>(body);
        params.put("taskId", id);
        var result = bridge.call(user.getName(), action, params);
        if (Set.of("apply", "discard").contains(action)) tasks.put(id, new Ownership(user.getName(), ""));
        return result;
    }

    @GetMapping("/preview/{id}/{ticket}/**")
    public ResponseEntity<byte[]> preview(@PathVariable String id, @PathVariable String ticket, HttpServletRequest req) throws Exception {
        var record = tasks.get(id);
        var expected = record == null ? null : record.ticket();
        if (expected == null || expected.isEmpty() || !java.security.MessageDigest.isEqual(expected.getBytes(java.nio.charset.StandardCharsets.UTF_8), ticket.getBytes(java.nio.charset.StandardCharsets.UTF_8)))
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        String prefix = "/preview/" + id + "/" + ticket;
        String path = req.getRequestURI().substring(prefix.length());
        if (req.getQueryString() != null) path += "?" + req.getQueryString();
        var p = bridge.call(record.user(), "preview", Map.of("taskId", id, "path", path));
        var headers = new HttpHeaders();
        headers.setContentType(MediaType.parseMediaType(p.path("type").asText()));
        headers.setCacheControl("no-store");
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Referrer-Policy", "no-referrer");
        // Untrusted project scripts share no Hub origin, even when opened in a separate tab.
        String csp = p.path("csp").asText();
        if (!csp.isBlank()) headers.add("Content-Security-Policy", csp);
        headers.add("Content-Security-Policy", "sandbox allow-scripts allow-forms; frame-ancestors 'self'");
        if (!p.path("frameOptions").asText().isBlank()) headers.set("X-Frame-Options", p.path("frameOptions").asText());
        return new ResponseEntity<>(Base64.getDecoder().decode(p.path("body").asText()), headers, HttpStatusCode.valueOf(p.path("status").asInt()));
    }

    @ExceptionHandler({IllegalArgumentException.class, IllegalStateException.class, java.util.concurrent.TimeoutException.class})
    ResponseEntity<Object> error(Exception e) {
        return ResponseEntity.badRequest().body(Map.of("error", e.getMessage() == null ? "요청 실패" : e.getMessage()));
    }
}
