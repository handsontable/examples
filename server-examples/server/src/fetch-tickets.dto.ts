import { Transform, Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

export class FilterConditionDto {
  @IsString()
  prop: string;

  @IsString()
  condition: string;

  @IsArray()
  @IsString({ each: true })
  value: string[];
}

export class SortDto {
  @IsString()
  column: string;

  @IsString()
  order: 'asc' | 'desc';
}

export class FetchTicketsDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page: number = 1;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  pageSize: number = 10;

  @IsOptional()
  @ValidateNested()
  @Type(() => SortDto)
  sort?: SortDto;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => FilterConditionDto)
  @Transform(({ value }) => (Array.isArray(value) ? value : value ? [value] : []))
  filters?: FilterConditionDto[];
}
