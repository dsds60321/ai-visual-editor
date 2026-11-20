package dev.visual;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.security.test.context.support.WithMockUser;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.mockito.Mockito.*;
import com.fasterxml.jackson.databind.ObjectMapper;
@WebMvcTest(value=Api.class,properties="hub.data-dir=target/test-hub-metadata") @Import(Security.class)
class ApiTest {
 @Autowired MockMvc mvc; @Autowired ObjectMapper mapper;
 @MockitoBean AgentBridge bridge; @MockitoBean Accounts accounts;
 @Test void loopbackSessionUsesLocalAccount()throws Exception{
 when(accounts.localUsername()).thenReturn("developer");
 mvc.perform(get("/api/session")).andExpect(status().isOk()).andExpect(jsonPath("$.user").value("developer")).andExpect(jsonPath("$.csrf").isNotEmpty());
 }
 @Test void rejectsNonlocalHostAndClient()throws Exception{
 mvc.perform(get("/api/session").with(request->{request.setServerName("example.invalid");return request;})).andExpect(status().isForbidden());
 mvc.perform(get("/api/session").with(request->{request.setRemoteAddr("192.0.2.1");return request;})).andExpect(status().isForbidden());
 verifyNoInteractions(bridge);
 }
 @Test void csrfRequiredForChanges()throws Exception{mvc.perform(post("/api/tasks").contentType("application/json").content("{\"projectId\":\"demo\"}")).andExpect(status().isForbidden());verifyNoInteractions(bridge);}
 @Test void previewRequiresTaskCapability()throws Exception{mvc.perform(get("/preview/unknown/invalid/")).andExpect(status().isNotFound());verifyNoInteractions(bridge);}
 @Test @WithMockUser(username="bob") void otherUsersCannotReadOrModifyTask()throws Exception{mvc.perform(get("/api/tasks/alice-task")).andExpect(status().isNotFound());mvc.perform(post("/api/tasks/alice-task/apply").with(csrf()).contentType("application/json").content("{}")).andExpect(status().isNotFound());verifyNoInteractions(bridge);}
 @Test @WithMockUser(username="alice") void ownerCanCreateAndInspectButBobCannot()throws Exception{
 when(bridge.call(eq("alice"),eq("create"),any())).thenReturn(mapper.readTree("{\"id\":\"owned\",\"previewBase\":\"/preview/owned/secret-ticket\"}"));
 when(bridge.call(eq("alice"),eq("status"),any())).thenReturn(mapper.readTree("{\"id\":\"owned\"}"));
 mvc.perform(post("/api/tasks").with(csrf()).contentType("application/json").content("{\"projectId\":\"demo\"}")).andExpect(status().isOk());
 mvc.perform(get("/api/tasks/owned")).andExpect(status().isOk());mvc.perform(get("/api/tasks/owned").with(user("bob"))).andExpect(status().isNotFound());
 mvc.perform(get("/api/tasks/owned/events").with(user("bob"))).andExpect(status().isNotFound());
 verify(bridge,never()).stream(anyString(),anyString());
 }
}
