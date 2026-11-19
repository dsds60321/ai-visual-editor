package dev.visual;
import java.io.IOException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.*;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.preauth.PreAuthenticatedAuthenticationToken;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.security.web.util.matcher.AntPathRequestMatcher;
import org.springframework.web.filter.OncePerRequestFilter;
@Configuration
public class Security {
    @Bean SecurityFilterChain filterChain(HttpSecurity http, Accounts accounts) throws Exception {
        return http.authorizeHttpRequests(a->a.requestMatchers("/agent","/inspector.js","/preview/**").permitAll().anyRequest().authenticated())
            .logout(AbstractHttpConfigurer::disable)
            .addFilterBefore(new OncePerRequestFilter() {
                @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
                        throws ServletException, IOException {
                    String host = request.getServerName();
                    if (!"127.0.0.1".equals(request.getRemoteAddr()) ||
                            !("127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host))) {
                        response.sendError(HttpServletResponse.SC_FORBIDDEN);
                        return;
                    }
                    var context = SecurityContextHolder.getContext();
                    if (context.getAuthentication() == null) {
                        context.setAuthentication(new PreAuthenticatedAuthenticationToken(
                            accounts.localUsername(), null, AuthorityUtils.NO_AUTHORITIES));
                    }
                    chain.doFilter(request, response);
                }
            }, CsrfFilter.class)
            .csrf(c->c.ignoringRequestMatchers(new AntPathRequestMatcher("/agent")))
            .headers(h->h.contentSecurityPolicy(c->c.policyDirectives("default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self' http://*.localhost:*; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")))
            .build();
    }
}
