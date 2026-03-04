import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from "@nestjs/common";
import { UserService } from "./user.service";
import { CreateUserDto } from "./create-user.dto";
import { UpdateUserDto } from "./update-user.dto";

@Controller("users")
export class UsersController {
  constructor(private readonly userService: UserService) {}

  @Get()
  async findAll(@Query("page") page?: string, @Query("limit") limit?: string) {
    if (page && limit) {
      return this.userService.findPaginated(parseInt(page), parseInt(limit));
    }
    return this.userService.findAll();
  }

  @Get("active")
  async findActive() {
    return this.userService.findActive();
  }

  @Get("inactive")
  async findInactive() {
    return this.userService.findInactive();
  }

  @Get("search")
  async search(@Query("q") query: string) {
    return this.userService.search(query);
  }

  @Get(":id")
  async findById(@Param("id") id: string) {
    return this.userService.findById(id);
  }

  @Post()
  async create(@Body() createUserDto: CreateUserDto) {
    return this.userService.create(createUserDto);
  }

  @Put(":id")
  async update(@Param("id") id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.userService.update(id, updateUserDto);
  }

  @Delete(":id")
  async delete(@Param("id") id: string) {
    return this.userService.delete(id);
  }
}
