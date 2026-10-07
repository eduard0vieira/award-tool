import { Type } from "class-transformer";
import { IsInt, IsISO8601, IsOptional, Max, Min } from "class-validator";

export class HistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "O campo limit deve ser um inteiro entre 1 e 200." })
  @Min(1, { message: "O campo limit deve ser um inteiro entre 1 e 200." })
  @Max(200, { message: "O campo limit deve ser um inteiro entre 1 e 200." })
  limit?: number;

  // Paging: pass the createdAt of the last item to get the older ones.
  @IsOptional()
  @IsISO8601({}, { message: "O campo before deve ser uma data ISO 8601." })
  before?: string;
}
