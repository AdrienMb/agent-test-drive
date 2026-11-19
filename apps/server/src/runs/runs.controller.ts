import { BadRequestException, Body, Controller, HttpCode, NotFoundException, Param, Post, Sse, type MessageEvent } from "@nestjs/common";
import { map, type Observable } from "rxjs";
import { RunsService } from "./runs.service.js";

@Controller("runs")
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Post()
  create(@Body() body: { prompt?: unknown }): { runId: string } {
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) throw new BadRequestException("prompt is required");
    return { runId: this.runs.start(prompt) };
  }

  /** SSE stream of RunEvent. Late subscribers get every event since the start. */
  @Sse(":id/events")
  events(@Param("id") id: string): Observable<MessageEvent> {
    const events$ = this.runs.events(id);
    if (!events$) throw new NotFoundException(`Unknown run ${id}`);
    return events$.pipe(map((event) => ({ data: event })));
  }

  @Post(":id/cancel")
  @HttpCode(204)
  cancel(@Param("id") id: string): void {
    if (!this.runs.cancel(id)) throw new NotFoundException(`Unknown run ${id}`);
  }
}
