import { Controller, Get, HttpCode } from "@nestjs/common";

/** Lets the web app check its passphrase: the gate answers 401 before this runs when it is wrong. */
@Controller("session")
export class SessionController {
  @Get()
  @HttpCode(204)
  check(): void {}
}
