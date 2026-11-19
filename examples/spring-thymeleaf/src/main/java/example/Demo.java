package example;
import org.springframework.boot.*;import org.springframework.boot.autoconfigure.*;import org.springframework.stereotype.Controller;import org.springframework.web.bind.annotation.GetMapping;import org.springframework.ui.Model;
@SpringBootApplication @Controller public class Demo {public static void main(String[] a){SpringApplication.run(Demo.class,a);}@GetMapping("/") public String index(Model m){m.addAttribute("title","주문 현황");return "index";}}
