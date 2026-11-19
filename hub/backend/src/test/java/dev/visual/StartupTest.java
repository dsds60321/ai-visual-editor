package dev.visual;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,properties={"hub.users-file=src/test/resources/users.json","hub.data-dir=target/test-startup-metadata"})
class StartupTest { @Test void fullApplicationStarts(){} }
